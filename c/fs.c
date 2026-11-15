#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include "quickjs.h"

static JSValue js_read_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;

    FILE *f = fopen(path, "rb");
    if (!f) {
        int err = errno;
        JS_FreeCString(ctx, path);
        return JS_ThrowInternalError(ctx, "readFile: %s", strerror(err));
    }

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size < 0) size = 0;

    char *buf = malloc((size_t)size + 1);
    if (!buf) { fclose(f); JS_FreeCString(ctx, path); return JS_ThrowOutOfMemory(ctx); }

    size_t n = fread(buf, 1, (size_t)size, f);
    fclose(f);
    buf[n] = 0;

    JSValue ret = JS_NewStringLen(ctx, buf, n);
    free(buf);
    JS_FreeCString(ctx, path);
    return ret;
}

static JSValue js_write_file(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;

    size_t len;
    const char *data = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!data) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }

    FILE *f = fopen(path, "wb");
    if (!f) {
        int err = errno;
        JS_FreeCString(ctx, path);
        JS_FreeCString(ctx, data);
        return JS_ThrowInternalError(ctx, "writeFile: %s", strerror(err));
    }

    size_t n = fwrite(data, 1, len, f);
    fclose(f);
    JS_FreeCString(ctx, path);
    JS_FreeCString(ctx, data);

    if (n != len) return JS_ThrowInternalError(ctx, "writeFile: short write");
    return JS_NewInt32(ctx, (int32_t)n);
}

static JSValue js_exists(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    struct stat st;
    int r = stat(path, &st);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, r == 0);
}

static JSValue js_mkdirp(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;

    char tmp[PATH_MAX];
    size_t len = strlen(path);
    if (len >= sizeof(tmp)) { JS_FreeCString(ctx, path); return JS_ThrowInternalError(ctx, "path too long"); }
    memcpy(tmp, path, len + 1);

    for (size_t i = 1; i < len; i++) {
        if (tmp[i] == '/') {
            tmp[i] = 0;
            mkdir(tmp, 0755);
            tmp[i] = '/';
        }
    }
    int r = mkdir(tmp, 0755);
    int err = errno;
    JS_FreeCString(ctx, path);
    if (r == 0 || err == EEXIST) return JS_UNDEFINED;
    return JS_ThrowInternalError(ctx, "mkdir: %s", strerror(err));
}

static JSValue js_remove(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    int r = remove(path);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, r == 0);
}

static JSValue js_getenv(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_EXCEPTION;
    const char *val = getenv(name);
    JS_FreeCString(ctx, name);
    return val ? JS_NewString(ctx, val) : JS_NULL;
}

static JSValue js_home_dir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    const char *h = getenv("HOME");
    return JS_NewString(ctx, h ? h : ".");
}

static const JSCFunctionListEntry fs_funcs[] = {
    JS_CFUNC_DEF("readFile",  1, js_read_file),
    JS_CFUNC_DEF("writeFile", 2, js_write_file),
    JS_CFUNC_DEF("exists",    1, js_exists),
    JS_CFUNC_DEF("mkdirp",    1, js_mkdirp),
    JS_CFUNC_DEF("remove",    1, js_remove),
    JS_CFUNC_DEF("getenv",    1, js_getenv),
    JS_CFUNC_DEF("homeDir",   0, js_home_dir),
};

static int fs_mod_init(JSContext *ctx, JSModuleDef *m) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, o, fs_funcs,
        sizeof(fs_funcs) / sizeof(fs_funcs[0]));
    JS_SetModuleExport(ctx, m, "default", o);
    return 0;
}

JSModuleDef *js_init_module(JSContext *ctx, const char *name) {
    JSModuleDef *m = JS_NewCModule(ctx, name, fs_mod_init);
    if (!m) return NULL;
    JS_AddModuleExport(ctx, m, "default");
    return m;
}
