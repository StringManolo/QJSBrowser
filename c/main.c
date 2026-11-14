#include <dlfcn.h>
#include <langinfo.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

typedef JSModuleDef *(*init_module_fn)(JSContext *, const char *);

typedef struct { init_module_fn net, tui; } Registry;

/* Try hard to get a UTF-8 locale active.
 * Returns the locale name that worked, or NULL if UTF-8 unavailable. */
static const char *ensure_utf8_locale(void) {
  static const char *candidates[] = {
    "",                                   /* respect env (LANG, LC_ALL, ...) */
    "C.UTF-8", "C.utf8", "C.UTF8",        /* built-in on glibc >= 2.35 */
    "en_US.UTF-8", "en_US.utf8",
    "en_GB.UTF-8", "en_GB.utf8",
    "es_ES.UTF-8", "es_ES.utf8",
    NULL
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
  FILE *f = fopen(p, "rb"); if (!f) return NULL;
  fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
  char *b = malloc(sz + 1);
  if (!b) { fclose(f); return NULL; }
  if (fread(b, 1, sz, f) != (size_t)sz) { free(b); fclose(f); return NULL; }
  b[sz] = 0; fclose(f); if (len) *len = sz; return b;
}

static JSModuleDef *browser_module_loader(JSContext *ctx,
                                          const char *module_name,
                                          void *opaque) {
  Registry *r = opaque;
  if (!strcmp(module_name, "network_sockets") && r->net) return r->net(ctx, module_name);
  if (!strcmp(module_name, "tui")             && r->tui) return r->tui(ctx, module_name);

  size_t len;
  char *src = read_file(module_name, &len);
  if (!src) {
    fprintf(stderr, "[loader] cannot read module: %s\n", module_name);
    return NULL;
  }
  JSValue v = JS_Eval(ctx, src, len, module_name,
                      JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
  free(src);
  if (JS_IsException(v)) {
    JSValue exc = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, exc);
    fprintf(stderr, "[loader] %s: %s\n", module_name, s ? s : "?");
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
  /* 1. Locale FIRST — before any UI, before QuickJS. */
  const char *loc = ensure_utf8_locale();
  if (!loc) {
    fprintf(stderr,
      "\n"
      "WARNING: no UTF-8 locale available.\n"
      "         The TUI will render non-ASCII characters (─ ↓ ↑ —) incorrectly.\n"
      "         Fix it with one of:\n"
      "           • Debian/Ubuntu:  apt install locales && localedef -i en_US -f UTF-8 en_US.UTF-8\n"
      "           • Alpine:         apk add musl-locales\n"
      "           • Arch:           edit /etc/locale.gen (uncomment en_US.UTF-8) && locale-gen\n"
      "           • Any (glibc>=2.35): export LANG=C.UTF-8\n"
      "\n");
  } else if (loc[0] == '\0') {
    fprintf(stderr, "[locale] environment: %s (%s)\n",
            setlocale(LC_CTYPE, NULL), nl_langinfo(CODESET));
  } else {
    fprintf(stderr, "[locale] forced: %s (%s)\n", loc, nl_langinfo(CODESET));
  }

  const char *net_path = argc > 1 ? argv[1] : "./lib/network_sockets.so";
  const char *tui_path = argc > 2 ? argv[2] : "./lib/tui.so";
  const char *js_path  = argc > 3 ? argv[3] : "./main.js";

  JSRuntime *rt = JS_NewRuntime();
  JSContext *ctx = JS_NewContext(rt);

  Registry reg = {0};
  void *h_net = dlopen(net_path, RTLD_NOW);
  void *h_tui = dlopen(tui_path, RTLD_NOW);
  if (!h_net || !h_tui) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
  reg.net = (init_module_fn)dlsym(h_net, "js_init_module");
  reg.tui = (init_module_fn)dlsym(h_tui, "js_init_module");
  if (!reg.net || !reg.tui) { fprintf(stderr, "dlsym failed\n"); return 1; }

  JS_SetModuleLoaderFunc(rt, NULL, browser_module_loader, &reg);

  size_t len; char *src = read_file(js_path, &len);
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
  dlclose(h_net); dlclose(h_tui);
  return rc;
}
