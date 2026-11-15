#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#include "quickjs.h"

#define MAX_OUTPUT (100 * 1024 * 1024)  /* 100MB cap */

/* ---- binary helpers (same contract as tls.c / image.c) ---- */

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

static JSValue u8_new(JSContext *ctx, const uint8_t *data, size_t len) {
    JSValue ab = JS_NewArrayBufferCopy(ctx, data, len);
    if (JS_IsException(ab)) return ab;

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
    JSValue args[1] = { ab };
    JSValue ta = JS_CallConstructor(ctx, ctor, 1, args);
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, ab);
    return ta;
}

/* ---- inflate core ---- */

static uint8_t *inflate_raw(const uint8_t *in, size_t in_len,
                            int windowBits, size_t *out_len) {
    if (in_len == 0) return NULL;

    z_stream strm;
    memset(&strm, 0, sizeof(strm));
    if (inflateInit2(&strm, windowBits) != Z_OK) return NULL;

    size_t cap = in_len * 3 + 4096;
    if (cap > MAX_OUTPUT) cap = MAX_OUTPUT;
    uint8_t *out = malloc(cap);
    if (!out) { inflateEnd(&strm); return NULL; }

    strm.next_in  = (Bytef *)in;
    strm.avail_in = (uInt)in_len;

    size_t total = 0;
    int ret;

    for (;;) {
        if (total >= cap) {
            if (cap >= MAX_OUTPUT) { free(out); inflateEnd(&strm); return NULL; }
            size_t new_cap = cap * 2;
            if (new_cap > MAX_OUTPUT) new_cap = MAX_OUTPUT;
            uint8_t *tmp = realloc(out, new_cap);
            if (!tmp) { free(out); inflateEnd(&strm); return NULL; }
            out = tmp;
            cap = new_cap;
        }

        strm.next_out  = out + total;
        strm.avail_out = (uInt)(cap - total);

        ret = inflate(&strm, Z_SYNC_FLUSH);
        total = cap - strm.avail_out;

        if (ret == Z_STREAM_END) break;
        if (ret == Z_OK) continue;
        if (ret == Z_BUF_ERROR) {
            if (strm.avail_out == 0) continue;  /* grow and retry */
            free(out); inflateEnd(&strm); return NULL;  /* truncated */
        }
        free(out); inflateEnd(&strm); return NULL;  /* data error etc */
    }

    inflateEnd(&strm);
    *out_len = total;
    return out;
}

/* inflate(data: Uint8Array, format: "gzip" | "deflate" | "auto") -> Uint8Array | null */
static JSValue js_inflate(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;

    size_t in_len = 0;
    uint8_t *in_data = u8_get(ctx, &in_len, argv[0]);
    if (!in_data) return JS_ThrowTypeError(ctx, "expected Uint8Array");
    if (in_len == 0) return u8_new(ctx, (const uint8_t *)"", 0);

    const char *fmt = JS_ToCString(ctx, argv[1]);
    if (!fmt) return JS_EXCEPTION;

    uint8_t *out = NULL;
    size_t out_len = 0;

    if (!strcmp(fmt, "gzip")) {
        out = inflate_raw(in_data, in_len, 16 + MAX_WBITS, &out_len);
    } else if (!strcmp(fmt, "deflate")) {
        /* zlib-wrapped first (RFC 1950), raw fallback (RFC 1951) */
        out = inflate_raw(in_data, in_len, MAX_WBITS, &out_len);
        if (!out) out = inflate_raw(in_data, in_len, -MAX_WBITS, &out_len);
    } else if (!strcmp(fmt, "auto")) {
        out = inflate_raw(in_data, in_len, 32 + MAX_WBITS, &out_len);
    } else {
        JS_FreeCString(ctx, fmt);
        return JS_ThrowTypeError(ctx, "unknown format (expected gzip, deflate, auto)");
    }
    JS_FreeCString(ctx, fmt);

    if (!out) return JS_NULL;

    JSValue result = u8_new(ctx, out, out_len);
    free(out);
    return result;
}

static const JSCFunctionListEntry zlib_funcs[] = {
    JS_CFUNC_DEF("inflate", 2, js_inflate),
};

static int zlib_mod_init(JSContext *ctx, JSModuleDef *m) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, o, zlib_funcs,
        sizeof(zlib_funcs) / sizeof(zlib_funcs[0]));
    JS_SetModuleExport(ctx, m, "default", o);
    return 0;
}

JSModuleDef *js_init_module(JSContext *ctx, const char *name) {
    JSModuleDef *m = JS_NewCModule(ctx, name, zlib_mod_init);
    if (!m) return NULL;
    JS_AddModuleExport(ctx, m, "default");
    return m;
}
