#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_ONLY_GIF
#define STBI_ONLY_BMP
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#include "stb_image.h"

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

static JSValue js_decode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;

    size_t len = 0;
    uint8_t *data = u8_get(ctx, &len, argv[0]);
    if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array");
    if (len == 0) return JS_NULL;

    /* Hard cap on decoded pixel buffer (protects against decompression bombs) */
    const int MAX_DIM = 8192;

    int w = 0, h = 0, channels = 0;
    unsigned char *pixels = stbi_load_from_memory(data, (int)len, &w, &h, &channels, 4);
    if (!pixels) return JS_NULL;

    if (w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM) {
        stbi_image_free(pixels);
        return JS_NULL;
    }

    size_t bytes = (size_t)w * (size_t)h * 4;
    JSValue copy_ab = JS_NewArrayBufferCopy(ctx, pixels, bytes);
    stbi_image_free(pixels);

    if (JS_IsException(copy_ab)) {
        return JS_NULL;
    }

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
    JSValue args[1] = { copy_ab };
    JSValue ta = JS_CallConstructor(ctx, ctor, 1, args);
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, copy_ab);

    if (JS_IsException(ta)) return JS_NULL;

    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "width",  JS_NewInt32(ctx, w));
    JS_SetPropertyStr(ctx, result, "height", JS_NewInt32(ctx, h));
    JS_SetPropertyStr(ctx, result, "rgba",   ta);
    return result;
}

static const JSCFunctionListEntry image_funcs[] = {
    JS_CFUNC_DEF("decode", 1, js_decode),
};

static int image_mod_init(JSContext *ctx, JSModuleDef *m) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, o, image_funcs,
        sizeof(image_funcs) / sizeof(image_funcs[0]));
    JS_SetModuleExport(ctx, m, "default", o);
    return 0;
}

JSModuleDef *js_init_module(JSContext *ctx, const char *name) {
    JSModuleDef *m = JS_NewCModule(ctx, name, image_mod_init);
    if (!m) return NULL;
    JS_AddModuleExport(ctx, m, "default");
    return m;
}
