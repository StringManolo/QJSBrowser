#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/tls1.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

typedef struct {
    SSL *ssl;
    BIO *rbio;
    BIO *wbio;
} TLSConnection;

/* One SSL_CTX for the whole process.
 *
 * Creating an SSL_CTX and loading the system CA bundle (~120-140 certs) is
 * expensive (tens of ms, much more on phones). Doing it per connection froze
 * the UI every time a page opened another HTTPS connection (one per image).
 * The context is created lazily on first use and never freed: it lives as
 * long as the process. SSL objects created from it only borrow it. */
static SSL_CTX *g_ctx = NULL;

static SSL_CTX *tls_shared_ctx(const char **err) {
    if (g_ctx) return g_ctx;

    SSL_CTX *c = SSL_CTX_new(TLS_client_method());
    if (!c) { *err = "SSL_CTX_new failed"; return NULL; }

    SSL_CTX_set_max_proto_version(c, TLS1_2_VERSION);

    /* Load system CA bundle for peer verification.
     * On Debian/Ubuntu: /etc/ssl/certs/ca-certificates.crt
     * On RHEL/Fedora: /etc/pki/tls/certs/ca-bundle.crt
     * OpenSSL probes multiple standard locations automatically. */
    if (SSL_CTX_set_default_verify_paths(c) != 1) {
        SSL_CTX_free(c);
        *err = "Failed to load system CA bundle (install ca-certificates?)";
        return NULL;
    }
    SSL_CTX_set_verify(c, SSL_VERIFY_PEER, NULL);

    g_ctx = c;
    return g_ctx;
}

static void tls_conn_free(TLSConnection *conn) {
    if (!conn) return;
    if (conn->ssl) SSL_free(conn->ssl);   /* also frees the BIOs it owns */
    free(conn);
}

static JSValue u8_new(JSContext *ctx, const uint8_t *data, size_t len) {
    JSValue ab = JS_NewArrayBufferCopy(ctx, data, len);
    if (JS_IsException(ab)) return ab;

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
    if (JS_IsException(ctor) || JS_IsUndefined(ctor)) {
        JS_FreeValue(ctx, ctor);
        JS_FreeValue(ctx, global);
        return ab;
    }
    JSValue args[1] = { ab };
    JSValue ta = JS_CallConstructor(ctx, ctor, 1, args);
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, ab);
    return ta;
}

static uint8_t *u8_get(JSContext *ctx, size_t *len, JSValueConst v) {
    size_t l = 0;
    uint8_t *p = JS_GetArrayBuffer(ctx, &l, v);
    if (p) { *len = l; return p; }

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

    const char *err = NULL;
    SSL_CTX *sctx = tls_shared_ctx(&err);
    if (!sctx) return JS_ThrowInternalError(ctx, "%s", err ? err : "TLS init failed");

    TLSConnection *conn = calloc(1, sizeof(TLSConnection));
    if (!conn) return JS_ThrowOutOfMemory(ctx);

    conn->ssl = SSL_new(sctx);
    if (!conn->ssl) { tls_conn_free(conn); return JS_ThrowInternalError(ctx, "SSL_new failed"); }

    conn->rbio = BIO_new(BIO_s_mem());
    conn->wbio = BIO_new(BIO_s_mem());
    if (!conn->rbio || !conn->wbio) {
        if (conn->rbio) BIO_free(conn->rbio);
        if (conn->wbio) BIO_free(conn->wbio);
        tls_conn_free(conn);
        return JS_ThrowInternalError(ctx, "BIO_new failed");
    }
    SSL_set_bio(conn->ssl, conn->rbio, conn->wbio);   /* SSL now owns both BIOs */
    SSL_set_connect_state(conn->ssl);

    return JS_NewInt64(ctx, (int64_t)(intptr_t)conn);
}

static JSValue js_tls_set_server_name(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    const char *name = JS_ToCString(ctx, argv[1]);
    if (!name) return JS_EXCEPTION;

    /* SNI (Server Name Indication) — selects the vhost */
    SSL_set_tlsext_host_name(conn->ssl, name);

    /* Hostname verification — ensures the cert's CN/SAN matches
     * the requested hostname. Requires SSL_VERIFY_PEER (set in new). */
    SSL_set1_host(conn->ssl, name);

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

    /* Certificate / hostname verification failure?
     * Surfaced as a distinct, human-readable message. */
    long vres = SSL_get_verify_result(conn->ssl);
    if (vres != X509_V_OK) {
        const char *reason = X509_verify_cert_error_string(vres);
        return JS_ThrowInternalError(ctx,
            "TLS cert verification failed: %s", reason ? reason : "unknown");
    }

    char err_buf[256];
    ERR_error_string_n(ERR_get_error(), err_buf, sizeof(err_buf));
    return JS_ThrowInternalError(ctx, "TLS handshake failed: %s", err_buf);
}

/* Utility — query current verify result (for debugging / UI messages). */
static JSValue js_tls_get_verify_result(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    long vres = SSL_get_verify_result(conn->ssl);
    if (vres == X509_V_OK) return JS_NewString(ctx, "OK");
    return JS_NewString(ctx, X509_verify_cert_error_string(vres));
}

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
    JS_CFUNC_DEF("getVerifyResult", 1, js_tls_get_verify_result),
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
