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

/* decode(bytes: Uint8Array) -> { width, height, rgba: Uint8Array } | null */
static JSValue js_decode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;

    /* Extract bytes from Uint8Array (portable across QuickJS versions) */
    size_t len = 0;
    uint8_t *data = NULL;

    /* Try as ArrayBuffer first */
    size_t ab_len = 0;
    uint8_t *ab = JS_GetArrayBuffer(ctx, &ab_len, argv[0]);
    if (ab) { data = ab; len = ab_len; }

    if (!data) {
        /* Fallback: byteOffset + byteLength + buffer */
        JSValue off_v = JS_GetPropertyStr(ctx, argv[0], "byteOffset");
        JSValue len_v = JS_GetPropertyStr(ctx, argv[0], "byteLength");
        JSValue buf_v = JS_GetPropertyStr(ctx, argv[0], "buffer");
        if (!JS_IsUndefined(off_v) && !JS_IsUndefined(len_v) && !JS_IsUndefined(buf_v)) {
            int64_t off = 0, blen = 0;
            JS_ToInt64(ctx, &off, off_v);
            JS_ToInt64(ctx, &blen, len_v);
            size_t buflen = 0;
            uint8_t *bdata = JS_GetArrayBuffer(ctx, &buflen, buf_v);
            if (bdata && off >= 0 && blen >= 0 && (size_t)off + (size_t)blen <= buflen) {
                data = bdata + off;
                len = (size_t)blen;
            }
        }
        JS_FreeValue(ctx, off_v);
        JS_FreeValue(ctx, len_v);
        JS_FreeValue(ctx, buf_v);
    }

    if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array");
    if (len == 0) return JS_NULL;

    int w = 0, h = 0, channels = 0;
    unsigned char *pixels = stbi_load_from_memory(data, (int)len, &w, &h, &channels, 4);
    if (!pixels) return JS_NULL;

    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "width",  JS_NewInt32(ctx, w));
    JS_SetPropertyStr(ctx, result, "height", JS_NewInt32(ctx, h));

    /* Wrap pixel buffer as an external ArrayBuffer that frees on GC */
    JSValue ab_v = JS_NewArrayBuffer(ctx, pixels, (size_t)w * h * 4,
        /* free_func */ NULL, /* opaque */ NULL,
        /* is_external */ 1);
    /* Better: use JS_NewArrayBufferCopy to detach from stb buffer */
    JS_FreeValue(ctx, ab_v);
    JSValue copy_ab = JS_NewArrayBufferCopy(ctx, pixels, (size_t)w * h * 4);
    stbi_image_free(pixels);

    /* Wrap ArrayBuffer as Uint8Array via constructor */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
    JSValue args[1] = { copy_ab };
    JSValue ta = JS_CallConstructor(ctx, ctor, 1, args);
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, copy_ab);

    JS_SetPropertyStr(ctx, result, "rgba", ta);
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
