#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/tls1.h>
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

typedef struct {
    SSL_CTX *ctx;
    SSL *ssl;
    BIO *rbio;
    BIO *wbio;
} TLSConnection;

static void tls_conn_free(TLSConnection *conn) {
    if (!conn) return;
    if (conn->ssl) SSL_free(conn->ssl);
    if (conn->ctx) SSL_CTX_free(conn->ctx);
    free(conn);
}

/* Create a Uint8Array from a C buffer. Portable across QuickJS versions:
 * builds an ArrayBuffer with JS_NewArrayBufferCopy, then wraps it via the
 * JS-level Uint8Array constructor. */
static JSValue u8_new(JSContext *ctx, const uint8_t *data, size_t len) {
    JSValue ab = JS_NewArrayBufferCopy(ctx, data, len);
    if (JS_IsException(ab)) return ab;

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
    if (JS_IsException(ctor) || JS_IsUndefined(ctor)) {
        JS_FreeValue(ctx, ctor);
        JS_FreeValue(ctx, global);
        return ab;  /* fallback: raw ArrayBuffer */
    }
    JSValue args[1] = { ab };
    JSValue ta = JS_CallConstructor(ctx, ctor, 1, args);
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, ab);
    return ta;
}

/* Get raw bytes from either an ArrayBuffer or a Uint8Array (including
 * subarrays). Returns NULL if the JS value isn't binary. */
static uint8_t *u8_get(JSContext *ctx, size_t *len, JSValueConst v) {
    /* Try as ArrayBuffer first */
    size_t l = 0;
    uint8_t *p = JS_GetArrayBuffer(ctx, &l, v);
    if (p) { *len = l; return p; }

    /* Try as TypedArray: read byteOffset / byteLength / buffer */
    JSValue off_v = JS_GetPropertyStr(ctx, v, "byteOffset");
    JSValue len_v = JS_GetPropertyStr(ctx, v, "byteLength");
    JSValue buf_v = JS_GetPropertyStr(ctx, v, "buffer");

    if (JS_IsUndefined(off_v) || JS_IsUndefined(len_v) || JS_IsUndefined(buf_v)) {
        JS_FreeValue(ctx, off_v);
        JS_FreeValue(ctx, len_v);
        JS_FreeValue(ctx, buf_v);
        return NULL;
    }

    int64_t off = 0, blen = 0;
    JS_ToInt64(ctx, &off, off_v);
    JS_ToInt64(ctx, &blen, len_v);
    JS_FreeValue(ctx, off_v);
    JS_FreeValue(ctx, len_v);

    size_t buflen = 0;
    uint8_t *bdata = JS_GetArrayBuffer(ctx, &buflen, buf_v);
    JS_FreeValue(ctx, buf_v);

    if (!bdata) return NULL;
    if (off < 0 || blen < 0) return NULL;
    if ((size_t)off + (size_t)blen > buflen) return NULL;

    *len = (size_t)blen;
    return bdata + off;
}

static JSValue js_tls_init(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_all_algorithms();
    return JS_UNDEFINED;
}

static JSValue js_tls_new(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    TLSConnection *conn = calloc(1, sizeof(TLSConnection));
    if (!conn) return JS_ThrowOutOfMemory(ctx);

    conn->ctx = SSL_CTX_new(TLS_client_method());
    if (!conn->ctx) { free(conn); return JS_ThrowInternalError(ctx, "SSL_CTX_new failed"); }

    /* Cap to TLS 1.2 — the TLS 1.3 ClientHello's large key_share extension
     * has been observed to trigger "illegal parameter" alerts against some
     * servers when driven through a manual Memory-BIO state machine. */
    SSL_CTX_set_max_proto_version(conn->ctx, TLS1_2_VERSION);

    /* MVP: no certificate validation. Swap to SSL_VERIFY_PEER and load a CA
     * bundle for production-grade safety. */
    SSL_CTX_set_verify(conn->ctx, SSL_VERIFY_NONE, NULL);

    conn->ssl = SSL_new(conn->ctx);
    if (!conn->ssl) { tls_conn_free(conn); return JS_ThrowInternalError(ctx, "SSL_new failed"); }

    conn->rbio = BIO_new(BIO_s_mem());
    conn->wbio = BIO_new(BIO_s_mem());
    if (!conn->rbio || !conn->wbio) {
        tls_conn_free(conn);
        return JS_ThrowInternalError(ctx, "BIO_new failed");
    }
    SSL_set_bio(conn->ssl, conn->rbio, conn->wbio);
    SSL_set_connect_state(conn->ssl);

    return JS_NewInt64(ctx, (int64_t)(intptr_t)conn);
}

/* Must be called BEFORE handshake for proper SNI. */
static JSValue js_tls_set_server_name(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    const char *name = JS_ToCString(ctx, argv[1]);
    if (!name) return JS_EXCEPTION;
    SSL_set_tlsext_host_name(conn->ssl, name);
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

static JSValue js_tls_handshake(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    int ret = SSL_do_handshake(conn->ssl);
    if (ret == 1) return JS_NewInt32(ctx, 1);

    int err = SSL_get_error(conn->ssl, ret);
    if (err == SSL_ERROR_WANT_READ)  return JS_NewInt32(ctx, 2);
    if (err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, 3);

    char err_buf[256];
    ERR_error_string_n(ERR_get_error(), err_buf, sizeof(err_buf));
    return JS_ThrowInternalError(ctx, "TLS handshake failed: %s", err_buf);
}

/* Plaintext read as string — kept for compatibility; not used by the
 * HTTP client anymore (readBytes is preferred for binary safety). */
static JSValue js_tls_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    char buf[16384];
    int n = SSL_read(conn->ssl, buf, sizeof(buf));
    if (n > 0) return JS_NewStringLen(ctx, buf, n);

    int err = SSL_get_error(conn->ssl, n);
    if (err == SSL_ERROR_WANT_READ)  return JS_NewInt32(ctx, -2);
    if (err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, -3);
    if (err == SSL_ERROR_ZERO_RETURN) return JS_NewInt32(ctx, -1);
    return JS_NewInt32(ctx, -4);
}

/* Plaintext read as raw bytes (Uint8Array). Binary-safe — the HTTP client
 * accumulates these across calls and decodes UTF-8 once at the end, which
 * prevents split multibyte sequences from becoming U+FFFD. */
static JSValue js_tls_read_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    uint8_t *tmp = malloc(16384);
    if (!tmp) return JS_ThrowOutOfMemory(ctx);

    int n = SSL_read(conn->ssl, tmp, 16384);
    if (n > 0) {
        JSValue out = u8_new(ctx, tmp, n);
        free(tmp);
        return out;
    }
    free(tmp);

    int err = SSL_get_error(conn->ssl, n);
    if (err == SSL_ERROR_WANT_READ)  return JS_NewInt32(ctx, -2);
    if (err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, -3);
    if (err == SSL_ERROR_ZERO_RETURN) return JS_NewInt32(ctx, -1);
    return JS_NewInt32(ctx, -4);
}

static JSValue js_tls_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    size_t len;
    const char *data = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!data) return JS_EXCEPTION;

    int n = SSL_write(conn->ssl, data, (int)len);
    JS_FreeCString(ctx, data);

    if (n > 0) return JS_NewInt32(ctx, n);

    int err = SSL_get_error(conn->ssl, n);
    if (err == SSL_ERROR_WANT_READ)  return JS_NewInt32(ctx, -2);
    if (err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, -3);
    return JS_NewInt32(ctx, -4);
}

/* Ciphertext out — returns Uint8Array (binary safe). */
static JSValue js_tls_get_outgoing(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    size_t pending = BIO_ctrl_pending(conn->wbio);
    if (pending == 0) return u8_new(ctx, (const uint8_t *)"", 0);

    uint8_t *tmp = malloc(pending);
    if (!tmp) return JS_ThrowOutOfMemory(ctx);

    int n = BIO_read(conn->wbio, tmp, (int)pending);
    if (n <= 0) { free(tmp); return u8_new(ctx, (const uint8_t *)"", 0); }

    JSValue out = u8_new(ctx, tmp, n);
    free(tmp);
    return out;
}

/* Ciphertext in — accepts Uint8Array or ArrayBuffer (binary safe). */
static JSValue js_tls_feed_incoming(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    size_t len = 0;
    uint8_t *data = u8_get(ctx, &len, argv[1]);
    if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array or ArrayBuffer");

    int n = BIO_write(conn->rbio, data, (int)len);
    return JS_NewInt32(ctx, n);
}

/* Binary-safe send to a socket fd. */
static JSValue js_tls_send_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int fd;
    if (JS_ToInt32(ctx, &fd, argv[0])) return JS_EXCEPTION;

    size_t len = 0;
    uint8_t *data = u8_get(ctx, &len, argv[1]);
    if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array or ArrayBuffer");

    ssize_t sent = send(fd, data, len, MSG_NOSIGNAL);
    if (sent < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) return JS_NewInt32(ctx, 0);
        return JS_ThrowInternalError(ctx, "send failed: %s", strerror(errno));
    }
    return JS_NewInt32(ctx, (int32_t)sent);
}

/* Binary-safe recv from a socket fd.
 *  - Uint8Array with length > 0  → data received
 *  - Uint8Array with length == 0 → EAGAIN (nothing right now)
 *  - null                        → EOF (peer closed)
 */
static JSValue js_tls_recv_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int fd, maxlen;
    if (JS_ToInt32(ctx, &fd, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &maxlen, argv[1])) return JS_EXCEPTION;
    if (maxlen > 65536) maxlen = 65536;
    if (maxlen <= 0) maxlen = 4096;

    uint8_t *buf = malloc(maxlen);
    if (!buf) return JS_ThrowOutOfMemory(ctx);

    ssize_t n = recv(fd, buf, maxlen, 0);
    if (n < 0) {
        free(buf);
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return u8_new(ctx, (const uint8_t *)"", 0);
        return JS_ThrowInternalError(ctx, "recv failed: %s", strerror(errno));
    }
    if (n == 0) { free(buf); return JS_NULL; }

    JSValue out = u8_new(ctx, buf, n);
    free(buf);
    return out;
}

static JSValue js_tls_free(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    tls_conn_free((TLSConnection *)(intptr_t)conn_ptr);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry tls_funcs[] = {
    JS_CFUNC_DEF("init", 0, js_tls_init),
    JS_CFUNC_DEF("new", 0, js_tls_new),
    JS_CFUNC_DEF("setServerName", 2, js_tls_set_server_name),
    JS_CFUNC_DEF("handshake", 1, js_tls_handshake),
    JS_CFUNC_DEF("read", 1, js_tls_read),
    JS_CFUNC_DEF("readBytes", 1, js_tls_read_bytes),
    JS_CFUNC_DEF("write", 2, js_tls_write),
    JS_CFUNC_DEF("getOutgoing", 1, js_tls_get_outgoing),
    JS_CFUNC_DEF("feedIncoming", 2, js_tls_feed_incoming),
    JS_CFUNC_DEF("sendBytes", 2, js_tls_send_bytes),
    JS_CFUNC_DEF("recvBytes", 2, js_tls_recv_bytes),
    JS_CFUNC_DEF("free", 1, js_tls_free),
};

static int tls_mod_init(JSContext *ctx, JSModuleDef *m) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, obj, tls_funcs, countof(tls_funcs));
    JS_SetModuleExport(ctx, m, "default", obj);
    return 0;
}

JSModuleDef *js_init_module(JSContext *ctx, const char *module_name) {
    JSModuleDef *m = JS_NewCModule(ctx, module_name, tls_mod_init);
    if (!m) return NULL;
    JS_AddModuleExport(ctx, m, "default");
    return m;
}
