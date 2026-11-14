#include <ncurses.h>
#include <langinfo.h>
#include <locale.h>
#include <string.h>
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

static JSValue t_init   (JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  initscr(); raw(); noecho(); nonl(); keypad(stdscr, TRUE);
  nodelay(stdscr, TRUE); curs_set(1); return JS_UNDEFINED;
}
static JSValue t_end    (JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  endwin(); return JS_UNDEFINED;
}
static JSValue t_getch  (JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  return JS_NewInt32(c, getch());
}
static JSValue t_print  (JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int y, x;
  if (JS_ToInt32(c, &y, av[0]) || JS_ToInt32(c, &x, av[1])) return JS_EXCEPTION;
  const char *s = JS_ToCString(c, av[2]);
  if (!s) return JS_EXCEPTION;
  mvaddstr(y, x, s);
  JS_FreeCString(c, s);
  return JS_UNDEFINED;
}
static JSValue t_move   (JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int y, x;
  if (JS_ToInt32(c, &y, av[0]) || JS_ToInt32(c, &x, av[1])) return JS_EXCEPTION;
  move(y, x); return JS_UNDEFINED;
}
static JSValue t_clrtoeol(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  clrtoeol(); return JS_UNDEFINED;
}
static JSValue t_erase  (JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  erase(); return JS_UNDEFINED;
}
static JSValue t_refresh(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  refresh(); return JS_UNDEFINED;
}
static JSValue t_attron (JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int a; if (JS_ToInt32(c, &a, av[0])) return JS_EXCEPTION;
  attron(a); return JS_UNDEFINED;
}
static JSValue t_attroff(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int a; if (JS_ToInt32(c, &a, av[0])) return JS_EXCEPTION;
  attroff(a); return JS_UNDEFINED;
}
static JSValue t_size   (JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  int r, cols; getmaxyx(stdscr, r, cols);
  JSValue o = JS_NewObject(c);
  JS_SetPropertyStr(c, o, "rows", JS_NewInt32(c, r));
  JS_SetPropertyStr(c, o, "cols", JS_NewInt32(c, cols));
  return o;
}

/* NEW: expose whether the locale is UTF-8, so JS can pick ASCII fallbacks. */
static JSValue t_utf8(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  const char *cs = nl_langinfo(CODESET);
  int yes = cs && (!strcmp(cs, "UTF-8") || !strcmp(cs, "utf8") || !strcmp(cs, "UTF8"));
  return JS_NewBool(c, yes);
}

/* NEW: return current LC_CTYPE locale name for debugging. */
static JSValue t_get_locale(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  const char *l = setlocale(LC_CTYPE, NULL);
  return JS_NewString(c, l ? l : "?");
}

static const JSCFunctionListEntry tui_funcs[] = {
  JS_CFUNC_DEF("init", 0, t_init),
  JS_CFUNC_DEF("end", 0, t_end),
  JS_CFUNC_DEF("getch", 0, t_getch),
  JS_CFUNC_DEF("print", 3, t_print),
  JS_CFUNC_DEF("move", 2, t_move),
  JS_CFUNC_DEF("clrtoeol", 0, t_clrtoeol),
  JS_CFUNC_DEF("erase", 0, t_erase),
  JS_CFUNC_DEF("refresh", 0, t_refresh),
  JS_CFUNC_DEF("attron", 1, t_attron),
  JS_CFUNC_DEF("attroff", 1, t_attroff),
  JS_CFUNC_DEF("size", 0, t_size),
  JS_CFUNC_DEF("utf8", 0, t_utf8),
  JS_CFUNC_DEF("getLocale", 0, t_get_locale),
};

static const JSCFunctionListEntry tui_consts[] = {
  JS_PROP_INT32_DEF("A_REVERSE",    A_REVERSE,    JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("A_BOLD",       A_BOLD,       JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("A_UNDERLINE",  A_UNDERLINE,  JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("A_NORMAL",     A_NORMAL,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_ENTER",    KEY_ENTER,    JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_BACKSPACE",KEY_BACKSPACE,JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_DC",       KEY_DC,       JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_LEFT",     KEY_LEFT,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_RIGHT",    KEY_RIGHT,    JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_UP",       KEY_UP,       JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_DOWN",     KEY_DOWN,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_HOME",     KEY_HOME,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_END",      KEY_END,      JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("ERR",          ERR,          JS_PROP_CONFIGURABLE),
};

static int tui_mod_init(JSContext *ctx, JSModuleDef *m) {
  JSValue o = JS_NewObject(ctx);
  JS_SetPropertyFunctionList(ctx, o, tui_funcs, countof(tui_funcs));
  JS_SetPropertyFunctionList(ctx, o, tui_consts, countof(tui_consts));
  JS_SetModuleExport(ctx, m, "default", o);
  return 0;
}

JSModuleDef *js_init_module(JSContext *ctx, const char *name) {
  JSModuleDef *m = JS_NewCModule(ctx, name, tui_mod_init);
  if (!m) return NULL;
  JS_AddModuleExport(ctx, m, "default");
  return m;
}
