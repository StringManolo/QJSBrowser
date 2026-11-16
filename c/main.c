#include <dlfcn.h>
#include <langinfo.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

typedef JSModuleDef *(*init_module_fn)(JSContext *, const char *);

typedef struct {
    init_module_fn net;
    init_module_fn tui;
    init_module_fn tls;
    init_module_fn image;
    init_module_fn zlib;
    init_module_fn fs;
    init_module_fn dns;
} Registry;

static const char *ensure_utf8_locale(void) {
    static const char *candidates[] = {
        "", "C.UTF-8", "C.utf8", "C.UTF8",
        "en_US.UTF-8", "en_US.utf8", "en_GB.UTF-8", "en_GB.utf8",
        "es_ES.UTF-8", "es_ES.utf8", NULL
    };
    for (int i = 0; candidates[i]; i++) {
        if (!setlocale(LC_ALL, candidates[i])) continue;
        const char *cs = nl_langinfo(CODESET);
        if (cs && (!strcmp(cs, "UTF-8") || !strcmp(cs, "utf8") || !strcmp(cs, "UTF8")))
            return candidates[i];
    }
    return NULL;
}

static char *read_file(const char *p, size_t *len) {
    FILE *f = fopen(p, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *b = malloc(sz + 1);
    if (!b) { fclose(f); return NULL; }
    if (fread(b, 1, sz, f) != (size_t)sz) { free(b); fclose(f); return NULL; }
    b[sz] = 0;
    fclose(f);
    if (len) *len = sz;
    return b;
}

/* [js] console bridge — used ONLY before main.js replaces console.* with
 * its own hookConsole wrapper. After that, console.error points at a JS
 * function that writes to the in-TUI devConsole (F12). */
static JSValue js_console_log(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val;
    fputs("[js] ", stderr);
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        if (s) {
            if (i) fputc(' ', stderr);
            fputs(s, stderr);
            JS_FreeCString(ctx, s);
        }
    }
    fputc('\n', stderr);
    fflush(stderr);
    return JS_UNDEFINED;
}

/* Emit a diagnostic through the JS console.error channel — which by the
 * time the page is running has been hooked by main.js to write to the
 * in-TUI dev console (F12). Falls back gracefully if console or
 * console.error is missing or throws.
 *
 * Re-entrancy guard: if console.error itself triggers another module
 * load that fails, we'd infinitely recurse. The guard lets us drop the
 * inner log and move on.
 *
 * Safety: every JS API call is checked for exceptions. Even a broken
 * log must not corrupt the loader — returning NULL still fails the
 * module load cleanly, just without the message.
 *
 * Note on the QuickJS call signature: the API is
 *   JS_Call(ctx, func_obj, this_obj, argc, argv)
 * (not JS_CallFunctionValue / JS_CallFunctionName / etc., which are
 * from newer QuickJS-ng or from V8). */ 
static void js_loader_log(JSContext *ctx, const char *msg) {
    static int in_log = 0;
    if (in_log) return;
    in_log = 1;

    JSValue global = JS_GetGlobalObject(ctx);
    if (JS_IsException(global)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        in_log = 0;
        return;
    }

    JSValue console = JS_GetPropertyStr(ctx, global, "console");
    if (JS_IsException(console)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, global);
        in_log = 0;
        return;
    }

    if (!JS_IsUndefined(console) && !JS_IsNull(console)) {
        JSValue errFn = JS_GetPropertyStr(ctx, console, "error");
        if (JS_IsException(errFn)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        } else if (JS_IsFunction(ctx, errFn)) {
            JSValue arg = JS_NewString(ctx, msg);
            JSValue ret = JS_Call(ctx, errFn, global, 1, &arg);
            if (JS_IsException(ret)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
            }
            JS_FreeValue(ctx, ret);
            JS_FreeValue(ctx, arg);
        }
        JS_FreeValue(ctx, errFn);
    }
    JS_FreeValue(ctx, console);
    JS_FreeValue(ctx, global);
    in_log = 0;
}

/* Drain QuickJS microtasks (promise callbacks) from the event loop.
 * Without this, any `await` or `.then()` scheduled by page JS never runs.
 * Capped at `max` jobs so a runaway promise chain cannot starve the TUI. */
static JSValue js_pump_jobs(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    (void)this_val;
    JSRuntime *rt = JS_GetRuntime(ctx);
    int max = 1000;
    if (argc > 0) {
        int32_t n;
        if (JS_ToInt32(ctx, &n, argv[0]) == 0 && n > 0) max = n;
    }
    JSContext *c;
    int n = 0;
    while (n < max) {
        int ret = JS_ExecutePendingJob(rt, &c);
        if (ret == 0) break;
        if (ret < 0) {
            /* Never fprintf to stderr here: ncurses owns the terminal and
             * raw bytes desync its model of the physical screen. Accumulate
             * the message in a global the JS side drains after each pump. */
            JSValue exc = JS_GetException(ctx);
            const char *s = JS_ToCString(ctx, exc);
            JSValue global = JS_GetGlobalObject(ctx);
            JSValue prev = JS_GetPropertyStr(ctx, global, "_lastPumpError");
            const char *prevS = NULL;
            if (!JS_IsUndefined(prev) && !JS_IsNull(prev))
                prevS = JS_ToCString(ctx, prev);
            const char *msg = s ? s : "(exception)";
            if (prevS && prevS[0]) {
                size_t len = strlen(prevS) + strlen(msg) + 2;
                char *buf = malloc(len);
                if (buf) {
                    snprintf(buf, len, "%s\n%s", prevS, msg);
                    JS_SetPropertyStr(ctx, global, "_lastPumpError",
                                      JS_NewString(ctx, buf));
                    free(buf);
                }
            } else {
                JS_SetPropertyStr(ctx, global, "_lastPumpError",
                                  JS_NewString(ctx, msg));
            }
            if (prevS) JS_FreeCString(ctx, prevS);
            if (s) JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, prev);
            JS_FreeValue(ctx, global);
            JS_FreeValue(ctx, exc);
        }
        n++;
    }
    return JS_NewInt32(ctx, n);
}

static JSModuleDef *browser_module_loader(JSContext *ctx,
                                          const char *module_name,
                                          void *opaque) {
    Registry *r = opaque;

    if (!strcmp(module_name, "network_sockets") && r->net)   return r->net(ctx, module_name);
    if (!strcmp(module_name, "tui")             && r->tui)   return r->tui(ctx, module_name);
    if (!strcmp(module_name, "tls")             && r->tls)   return r->tls(ctx, module_name);
    if (!strcmp(module_name, "image")           && r->image) return r->image(ctx, module_name);
    if (!strcmp(module_name, "zlib")            && r->zlib)  return r->zlib(ctx, module_name);
    if (!strcmp(module_name, "fs")              && r->fs)    return r->fs(ctx, module_name);
    if (!strcmp(module_name, "dns")             && r->dns)   return r->dns(ctx, module_name);

    char buf[1024];

    /* Diagnostic: log every request that reaches the fallback path.
     * Our own modules (src slash js, main.js) are legitimate — they
     * live on disk and get loaded through this same callback. But a
     * request for a Vite chunk filename (hash-like, e.g.
     * "index-CtL5pFWs.js") means page JS called NATIVE import() — our
     * ESM transpiler missed that particular import() expression.
     * Flag those loudly so we can find the offender. */
    int is_bare = strchr(module_name, '/') == NULL;
    int is_internal = strncmp(module_name, "src/", 4) == 0 ||
                      strncmp(module_name, "./src/", 6) == 0 ||
                      strcmp(module_name, "main.js") == 0;

    if (is_bare && !is_internal) {
        snprintf(buf, sizeof(buf),
                 "[loader] native import() reached C loader: %s — "
                 "ESM transpiler missed this expression", module_name);
        js_loader_log(ctx, buf);
    }

    size_t len;
    char *src = read_file(module_name, &len);
    if (!src) {
        snprintf(buf, sizeof(buf),
                 "[loader] cannot read module: %s", module_name);
        js_loader_log(ctx, buf);
        return NULL;
    }
    JSValue v = JS_Eval(ctx, src, len, module_name,
                        JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(src);
    if (JS_IsException(v)) {
        JSValue exc = JS_GetException(ctx);
        const char *s = JS_ToCString(ctx, exc);
        snprintf(buf, sizeof(buf),
                 "[loader] compile failed for %s: %s",
                 module_name, s ? s : "?");
        js_loader_log(ctx, buf);
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, v);
        return NULL;
    }
    JSModuleDef *m = JS_VALUE_GET_PTR(v);
    JS_FreeValue(ctx, v);
    return m;
}

int main(int argc, char **argv) {
    const char *loc = ensure_utf8_locale();
    if (!loc) {
        fprintf(stderr, "\nWARNING: no UTF-8 locale available.\n\n");
    } else if (loc[0] == '\0') {
        fprintf(stderr, "[locale] environment: %s (%s)\n",
                setlocale(LC_CTYPE, NULL), nl_langinfo(CODESET));
    } else {
        fprintf(stderr, "[locale] forced: %s (%s)\n", loc, nl_langinfo(CODESET));
    }

    const char *net_path   = argc > 1 ? argv[1] : "./lib/network_sockets.so";
    const char *tui_path   = argc > 2 ? argv[2] : "./lib/tui.so";
    const char *tls_path   = argc > 3 ? argv[3] : "./lib/tls.so";
    const char *image_path = argc > 4 ? argv[4] : "./lib/image.so";
    const char *zlib_path  = argc > 5 ? argv[5] : "./lib/zlib.so";
    const char *fs_path    = argc > 6 ? argv[6] : "./lib/fs.so";
    const char *js_path    = argc > 7 ? argv[7] : "./main.js";
    const char *dns_path   = argc > 8 ? argv[8] : "./lib/dns.so";

    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    if (!rt || !ctx) { fprintf(stderr, "quickjs init failed\n"); return 1; }

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "log",
        JS_NewCFunction(ctx, js_console_log, "log", 1));
    JS_SetPropertyStr(ctx, console, "error",
        JS_NewCFunction(ctx, js_console_log, "error", 1));
    JS_SetPropertyStr(ctx, global, "console", console);
    JS_SetPropertyStr(ctx, global, "pumpJobs",
        JS_NewCFunction(ctx, js_pump_jobs, "pumpJobs", 1));
    JS_FreeValue(ctx, global);

    Registry reg = {0};
    void *h_net   = dlopen(net_path,   RTLD_NOW);
    void *h_tui   = dlopen(tui_path,   RTLD_NOW);
    void *h_tls   = dlopen(tls_path,   RTLD_NOW);
    void *h_image = dlopen(image_path, RTLD_NOW);
    void *h_zlib  = dlopen(zlib_path,  RTLD_NOW);
    void *h_fs    = dlopen(fs_path,    RTLD_NOW);
    void *h_dns   = dlopen(dns_path,   RTLD_NOW);
    if (!h_net || !h_tui || !h_tls || !h_image || !h_zlib || !h_fs || !h_dns) {
        fprintf(stderr, "dlopen: %s\n", dlerror());
        return 1;
    }
    reg.net   = (init_module_fn)dlsym(h_net,   "js_init_module");
    reg.tui   = (init_module_fn)dlsym(h_tui,   "js_init_module");
    reg.tls   = (init_module_fn)dlsym(h_tls,   "js_init_module");
    reg.image = (init_module_fn)dlsym(h_image, "js_init_module");
    reg.zlib  = (init_module_fn)dlsym(h_zlib,  "js_init_module");
    reg.fs    = (init_module_fn)dlsym(h_fs,    "js_init_module");
    reg.dns   = (init_module_fn)dlsym(h_dns,   "js_init_module");
    if (!reg.net || !reg.tui || !reg.tls || !reg.image || !reg.zlib || !reg.fs || !reg.dns) {
        fprintf(stderr, "dlsym failed\n"); return 1;
    }

    JS_SetModuleLoaderFunc(rt, NULL, browser_module_loader, &reg);

    size_t len;
    char *src = read_file(js_path, &len);
    if (!src) { fprintf(stderr, "cannot read %s\n", js_path); return 1; }

    JSValue r = JS_Eval(ctx, src, len, js_path, JS_EVAL_TYPE_MODULE);
    int rc = 0;
    if (JS_IsException(r)) {
        JSValue e = JS_GetException(ctx);
        const char *s = JS_ToCString(ctx, e);
        fprintf(stderr, "JS error: %s\n", s ? s : "?");
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, e);
        rc = 1;
    }
    JS_FreeValue(ctx, r);

    JSContext *uj;
    while (JS_ExecutePendingJob(rt, &uj) > 0) {}

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    free(src);
    dlclose(h_net); dlclose(h_tui); dlclose(h_tls);
    dlclose(h_image); dlclose(h_zlib); dlclose(h_fs); dlclose(h_dns);
    return rc;
}
