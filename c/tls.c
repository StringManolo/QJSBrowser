#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

// Estructura que mantiene el estado de una conexión TLS
typedef struct {
    SSL_CTX *ctx;
    SSL *ssl;
    BIO *rbio; // BIO de memoria para leer datos de red
    BIO *wbio; // BIO de memoria para escribir datos a red
} TLSConnection;

// Libera todos los recursos de una conexión TLS
static void tls_conn_free(TLSConnection *conn) {
    if (!conn) return;
    if (conn->ssl) SSL_free(conn->ssl);
    if (conn->ctx) SSL_CTX_free(conn->ctx);
    free(conn);
}

// Inicializa la librería OpenSSL (llamar una vez)
static JSValue js_tls_init(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_all_algorithms();
    return JS_UNDEFINED;
}

// Crea un nuevo objeto de conexión TLS
static JSValue js_tls_new(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    TLSConnection *conn = calloc(1, sizeof(TLSConnection));
    if (!conn) return JS_ThrowOutOfMemory(ctx);

    conn->ctx = SSL_CTX_new(TLS_client_method());
    if (!conn->ctx) { free(conn); return JS_ThrowInternalError(ctx, "SSL_CTX_new failed"); }

    // En un navegador real, aquí se cargarían los certificados de CA del sistema.
    // Para el MVP, deshabilitamos la verificación de certificados.
    SSL_CTX_set_verify(conn->ctx, SSL_VERIFY_NONE, NULL);

    conn->ssl = SSL_new(conn->ctx);
    if (!conn->ssl) { tls_conn_free(conn); return JS_ThrowInternalError(ctx, "SSL_new failed"); }

    // Crear y adjuntar los Memory BIOs
    conn->rbio = BIO_new(BIO_s_mem());
    conn->wbio = BIO_new(BIO_s_mem());
    if (!conn->rbio || !conn->wbio) { tls_conn_free(conn); return JS_ThrowInternalError(ctx, "BIO_new failed"); }
    SSL_set_bio(conn->ssl, conn->rbio, conn->wbio);
    SSL_set_connect_state(conn->ssl); // Somos un cliente

    // Devolver un puntero opaco a la conexión
    return JS_NewInt64(ctx, (int64_t)(intptr_t)conn);
}

// Inicia o continúa el handshake TLS
static JSValue js_tls_handshake(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    int ret = SSL_do_handshake(conn->ssl);
    if (ret == 1) {
        return JS_NewInt32(ctx, 1); // Handshake completado
    }

    int err = SSL_get_error(conn->ssl, ret);
    if (err == SSL_ERROR_WANT_READ)  return JS_NewInt32(ctx, 2); // Quiere leer
    if (err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, 3); // Quiere escribir

    // Error fatal
    char err_buf[256];
    ERR_error_string_n(ERR_get_error(), err_buf, sizeof(err_buf));
    return JS_ThrowInternalError(ctx, "TLS handshake failed: %s", err_buf);
}

// Lee datos ya descifrados de OpenSSL
static JSValue js_tls_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    char buf[16384];
    int n = SSL_read(conn->ssl, buf, sizeof(buf));
    if (n > 0) {
        return JS_NewStringLen(ctx, buf, n);
    }

    int err = SSL_get_error(conn->ssl, n);
    if (err == SSL_ERROR_WANT_READ)  return JS_NewInt32(ctx, -2); // No hay datos ahora
    if (err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, -3); // Quiere escribir
    if (err == SSL_ERROR_ZERO_RETURN) return JS_NewInt32(ctx, -1); // Conexión cerrada

    return JS_NewInt32(ctx, -4); // Error
}

// Encripta y encola datos para enviar
static JSValue js_tls_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    size_t len;
    const char *data = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!data) return JS_EXCEPTION;

    int n = SSL_write(conn->ssl, data, (int)len);
    JS_FreeCString(ctx, data);

    if (n > 0) {
        return JS_NewInt32(ctx, n);
    }

    int err = SSL_get_error(conn->ssl, n);
    if (err == SSL_ERROR_WANT_READ)  return JS_NewInt32(ctx, -2);
    if (err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, -3);

    return JS_NewInt32(ctx, -4);
}

// Extrae los datos encriptados pendientes para enviar por el socket
static JSValue js_tls_get_outgoing(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    size_t pending = BIO_ctrl_pending(conn->wbio);
    if (pending == 0) return JS_NewString(ctx, "");

    char *buf = malloc(pending);
    if (!buf) return JS_ThrowOutOfMemory(ctx);

    int n = BIO_read(conn->wbio, buf, (int)pending);
    if (n <= 0) {
        free(buf);
        return JS_NewString(ctx, "");
    }

    JSValue ret = JS_NewStringLen(ctx, buf, n);
    free(buf);
    return ret;
}

// Alimenta datos encriptados recibidos de la red a OpenSSL
static JSValue js_tls_feed_incoming(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    if (!conn) return JS_ThrowInternalError(ctx, "invalid connection");

    size_t len;
    const char *data = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!data) return JS_EXCEPTION;

    int n = BIO_write(conn->rbio, data, (int)len);
    JS_FreeCString(ctx, data);

    return JS_NewInt32(ctx, n);
}

// Libera una conexión TLS
static JSValue js_tls_free(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int64_t conn_ptr;
    if (JS_ToInt64(ctx, &conn_ptr, argv[0])) return JS_EXCEPTION;
    TLSConnection *conn = (TLSConnection *)(intptr_t)conn_ptr;
    tls_conn_free(conn);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry tls_funcs[] = {
    JS_CFUNC_DEF("init", 0, js_tls_init),
    JS_CFUNC_DEF("new", 0, js_tls_new),
    JS_CFUNC_DEF("handshake", 1, js_tls_handshake),
    JS_CFUNC_DEF("read", 1, js_tls_read),
    JS_CFUNC_DEF("write", 2, js_tls_write),
    JS_CFUNC_DEF("getOutgoing", 1, js_tls_get_outgoing),
    JS_CFUNC_DEF("feedIncoming", 2, js_tls_feed_incoming),
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
