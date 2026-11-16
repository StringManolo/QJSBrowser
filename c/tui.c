#include <ncurses.h>
#include <langinfo.h>
#include <locale.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "quickjs.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

static JSValue t_init(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  initscr(); raw(); noecho(); nonl(); keypad(stdscr, TRUE);
  nodelay(stdscr, TRUE); curs_set(1); return JS_UNDEFINED;
}
static JSValue t_end(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  endwin(); return JS_UNDEFINED;
}
static JSValue t_getch(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  return JS_NewInt32(c, getch());
}
static JSValue t_print(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int y, x;
  if (JS_ToInt32(c, &y, av[0]) || JS_ToInt32(c, &x, av[1])) return JS_EXCEPTION;
  const char *s = JS_ToCString(c, av[2]);
  if (!s) return JS_EXCEPTION;
  mvaddstr(y, x, s);
  JS_FreeCString(c, s);
  return JS_UNDEFINED;
}
static JSValue t_move(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int y, x;
  if (JS_ToInt32(c, &y, av[0]) || JS_ToInt32(c, &x, av[1])) return JS_EXCEPTION;
  move(y, x); return JS_UNDEFINED;
}
static JSValue t_clrtoeol(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  clrtoeol(); return JS_UNDEFINED;
}
static JSValue t_erase(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  erase(); return JS_UNDEFINED;
}
static JSValue t_refresh(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  refresh(); return JS_UNDEFINED;
}
static JSValue t_attron(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int a; if (JS_ToInt32(c, &a, av[0])) return JS_EXCEPTION;
  attron(a); return JS_UNDEFINED;
}
static JSValue t_attroff(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int a; if (JS_ToInt32(c, &a, av[0])) return JS_EXCEPTION;
  attroff(a); return JS_UNDEFINED;
}
static JSValue t_size(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  int r, cols; getmaxyx(stdscr, r, cols);
  JSValue o = JS_NewObject(c);
  JS_SetPropertyStr(c, o, "rows", JS_NewInt32(c, r));
  JS_SetPropertyStr(c, o, "cols", JS_NewInt32(c, cols));
  return o;
}
static JSValue t_utf8(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  const char *cs = nl_langinfo(CODESET);
  int yes = cs && (!strcmp(cs, "UTF-8") || !strcmp(cs, "utf8") || !strcmp(cs, "UTF8"));
  return JS_NewBool(c, yes);
}
static JSValue t_get_locale(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  const char *l = setlocale(LC_CTYPE, NULL);
  return JS_NewString(c, l ? l : "?");
}

static JSValue t_init_colors(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  if (!has_colors()) return JS_NewInt32(c, 0);
  start_color();
  use_default_colors();
  return JS_NewInt32(c, COLORS);
}

static JSValue t_define_pair(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int id, fg, bg;
  if (JS_ToInt32(c, &id, av[0])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &fg, av[1])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &bg, av[2])) return JS_EXCEPTION;
  init_pair((short)id, (short)fg, (short)bg);
  return JS_UNDEFINED;
}

/* printPair(y, x, text, pairId [, flags])
 * Optional 5th arg: A_BOLD | A_UNDERLINE | A_REVERSE | A_DIM */
static JSValue t_print_pair(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v;
  int y, x, pairId, flags = 0;
  if (JS_ToInt32(c, &y, av[0])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &x, av[1])) return JS_EXCEPTION;
  const char *s = JS_ToCString(c, av[2]);
  if (!s) return JS_EXCEPTION;
  if (JS_ToInt32(c, &pairId, av[3])) { JS_FreeCString(c, s); return JS_EXCEPTION; }
  if (ac >= 5 && !JS_IsUndefined(av[4]) && !JS_IsNull(av[4])) {
    if (JS_ToInt32(c, &flags, av[4])) { JS_FreeCString(c, s); return JS_EXCEPTION; }
  }
  int safe = flags & (A_BOLD | A_UNDERLINE | A_REVERSE | A_DIM);
  attrset(COLOR_PAIR(pairId) | safe);
  mvaddstr(y, x, s);
  attrset(A_NORMAL);
  JS_FreeCString(c, s);
  return JS_UNDEFINED;
}

static JSValue t_fill_pair(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int y, x, h, w, pairId;
  if (JS_ToInt32(c, &y, av[0])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &x, av[1])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &h, av[2])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &w, av[3])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &pairId, av[4])) return JS_EXCEPTION;
  attrset(COLOR_PAIR(pairId));
  for (int i = 0; i < h; i++) mvhline(y + i, x, ' ', w);
  attrset(A_NORMAL);
  return JS_UNDEFINED;
}

static JSValue t_box(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int y, x, h, w, pairId, style;
  if (JS_ToInt32(c, &y, av[0])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &x, av[1])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &h, av[2])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &w, av[3])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &pairId, av[4])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &style, av[5])) return JS_EXCEPTION;
  if (h < 2 || w < 2) return JS_UNDEFINED;

  const char *tl, *tr, *bl, *br, *hc, *vc;
  switch (style) {
    case 0: tl = "╭"; tr = "╮"; bl = "╰"; br = "╯"; hc = "─"; vc = "│"; break;
    case 1: tl = "┌"; tr = "┐"; bl = "└"; br = "┘"; hc = "─"; vc = "│"; break;
    case 2: tl = "+"; tr = "+"; bl = "+"; br = "+"; hc = "-"; vc = "|"; break;
    default: tl = "┌"; tr = "┐"; bl = "└"; br = "┘"; hc = "─"; vc = "│"; break;
  }

  attrset(COLOR_PAIR(pairId));
  int hc_len = strlen(hc);
  int line_len = (w - 2) * hc_len + strlen(tl) + strlen(tr) + 1;
  char *top = malloc(line_len);
  char *bot = malloc(line_len);
  if (top && bot) {
    int pos = 0;
    pos += sprintf(top + pos, "%s", tl);
    for (int i = 0; i < w - 2; i++) { memcpy(top + pos, hc, hc_len); pos += hc_len; }
    pos += sprintf(top + pos, "%s", tr);
    top[pos] = 0;
    mvaddstr(y, x, top);

    pos = 0;
    pos += sprintf(bot + pos, "%s", bl);
    for (int i = 0; i < w - 2; i++) { memcpy(bot + pos, hc, hc_len); pos += hc_len; }
    pos += sprintf(bot + pos, "%s", br);
    bot[pos] = 0;
    mvaddstr(y + h - 1, x, bot);

    for (int i = 1; i < h - 1; i++) {
      mvaddstr(y + i, x, vc);
      mvaddstr(y + i, x + w - 1, vc);
    }
  }
  free(top); free(bot);
  attrset(A_NORMAL);
  return JS_UNDEFINED;
}

static JSValue t_hline(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int y, x, w, pairId;
  if (JS_ToInt32(c, &y, av[0])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &x, av[1])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &w, av[2])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &pairId, av[3])) return JS_EXCEPTION;
  const char *ch = JS_ToCString(c, av[4]);
  if (!ch) return JS_EXCEPTION;
  int ch_len = strlen(ch);
  char *line = malloc(w * ch_len + 1);
  if (line) {
    for (int i = 0; i < w; i++) memcpy(line + i * ch_len, ch, ch_len);
    line[w * ch_len] = 0;
    attrset(COLOR_PAIR(pairId));
    mvaddstr(y, x, line);
    attrset(A_NORMAL);
  }
  free(line);
  JS_FreeCString(c, ch);
  return JS_UNDEFINED;
}

static JSValue t_set_cursor(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int vis;
  if (JS_ToInt32(c, &vis, av[0])) return JS_EXCEPTION;
  curs_set(vis ? 1 : 0);
  return JS_UNDEFINED;
}

static JSValue t_ungetch(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int ch;
  if (JS_ToInt32(c, &ch, av[0])) return JS_EXCEPTION;
  return JS_NewInt32(c, ungetch(ch));
}

/* Force the next refresh() to repaint the physical screen from scratch.
 * Used to eliminate stale cells left behind by overlays (console, images). */
static JSValue t_clearok(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  clearok(stdscr, TRUE);
  return JS_UNDEFINED;
}

static JSValue t_mouse_enable(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  mmask_t supported = mousemask(
    BUTTON1_CLICKED | BUTTON1_PRESSED | BUTTON1_RELEASED |
    BUTTON4_PRESSED | BUTTON5_PRESSED, NULL);
  mouseinterval(100);
  return JS_NewBool(c, supported != 0);
}
static JSValue t_mouse_disable(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  mousemask(0, NULL);
  return JS_UNDEFINED;
}
static JSValue t_get_mouse(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac; (void)av;
  MEVENT event;
  if (getmouse(&event) != OK) return JS_NULL;
  JSValue o = JS_NewObject(c);
  JS_SetPropertyStr(c, o, "x",      JS_NewInt32(c, event.x));
  JS_SetPropertyStr(c, o, "y",      JS_NewInt32(c, event.y));
  JS_SetPropertyStr(c, o, "bstate", JS_NewInt64(c, (int64_t)event.bstate));
  JS_SetPropertyStr(c, o, "id",     JS_NewInt32(c, event.id));
  return o;
}

/* ---------- truecolor cells ---------- */

typedef struct { int y, x; int fg, bg; char ch[8]; } RgbCell;

static RgbCell *g_pending = NULL;
static int g_pending_n = 0, g_pending_cap = 0;
static RgbCell *g_prev    = NULL;
static int g_prev_n = 0, g_prev_cap = 0;

static JSValue t_print_rgb(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int y, x, fg, bg;
  if (JS_ToInt32(c, &y,  av[0])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &x,  av[1])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &fg, av[2])) return JS_EXCEPTION;
  if (JS_ToInt32(c, &bg, av[3])) return JS_EXCEPTION;
  const char *ch = JS_ToCString(c, av[4]);
  if (!ch) return JS_EXCEPTION;
  if (g_pending_n >= g_pending_cap) {
    g_pending_cap = g_pending_cap ? g_pending_cap * 2 : 256;
    g_pending = realloc(g_pending, g_pending_cap * sizeof(RgbCell));
  }
  RgbCell *cell = &g_pending[g_pending_n++];
  cell->y = y; cell->x = x; cell->fg = fg; cell->bg = bg;
  strncpy(cell->ch, ch, 7); cell->ch[7] = 0;
  JS_FreeCString(c, ch);
  return JS_UNDEFINED;
}

static JSValue t_maybe_clearok(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)c; (void)v; (void)ac; (void)av;
  if (g_prev_n > 0) clearok(stdscr, TRUE);
  return JS_UNDEFINED;
}

static JSValue t_flush_images(JSContext *c, JSValueConst v, int ac, JSValueConst *av) {
  (void)v; (void)ac;
  int cursor_y = 0, cursor_x = 0;
  if (ac >= 1) JS_ToInt32(c, &cursor_y, av[0]);
  if (ac >= 2) JS_ToInt32(c, &cursor_x, av[1]);

  fflush(stdout);
  for (int i = 0; i < g_pending_n; i++) {
    RgbCell *cell = &g_pending[i];
    int r   = (cell->fg >> 16) & 0xFF, g   = (cell->fg >> 8) & 0xFF, b   = cell->fg & 0xFF;
    int br  = (cell->bg >> 16) & 0xFF, bg_ = (cell->bg >> 8) & 0xFF, bb  = cell->bg & 0xFF;
    printf("\033[%d;%dH\033[38;2;%d;%d;%dm\033[48;2;%d;%d;%dm%s\033[0m",
           cell->y + 1, cell->x + 1, r, g, b, br, bg_, bb, cell->ch);
  }
  printf("\033[%d;%dH", cursor_y + 1, cursor_x + 1);
  fflush(stdout);

  if (g_pending_n > g_prev_cap) {
    g_prev_cap = g_pending_n;
    g_prev = realloc(g_prev, g_prev_cap * sizeof(RgbCell));
  }
  if (g_prev && g_pending_n > 0)
    memcpy(g_prev, g_pending, g_pending_n * sizeof(RgbCell));
  g_prev_n = g_pending_n;
  g_pending_n = 0;
  return JS_UNDEFINED;
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
  JS_CFUNC_DEF("initColors", 0, t_init_colors),
  JS_CFUNC_DEF("definePair", 3, t_define_pair),
  JS_CFUNC_DEF("printPair", 4, t_print_pair),
  JS_CFUNC_DEF("fillPair", 5, t_fill_pair),
  JS_CFUNC_DEF("box", 6, t_box),
  JS_CFUNC_DEF("hline", 5, t_hline),
  JS_CFUNC_DEF("setCursor", 1, t_set_cursor),
  JS_CFUNC_DEF("ungetch", 1, t_ungetch),
  JS_CFUNC_DEF("clearok", 0, t_clearok),
  JS_CFUNC_DEF("mouseEnable", 0, t_mouse_enable),
  JS_CFUNC_DEF("mouseDisable", 0, t_mouse_disable),
  JS_CFUNC_DEF("getMouse", 0, t_get_mouse),
  JS_CFUNC_DEF("printRgb", 5, t_print_rgb),
  JS_CFUNC_DEF("flushImages", 2, t_flush_images),
  JS_CFUNC_DEF("maybeClearok", 0, t_maybe_clearok),
};

static const JSCFunctionListEntry tui_consts[] = {
  JS_PROP_INT32_DEF("A_REVERSE",     A_REVERSE,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("A_BOLD",        A_BOLD,        JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("A_UNDERLINE",   A_UNDERLINE,   JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("A_NORMAL",      A_NORMAL,      JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_ENTER",     KEY_ENTER,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_BACKSPACE", KEY_BACKSPACE, JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_DC",        KEY_DC,        JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_LEFT",      KEY_LEFT,      JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_RIGHT",     KEY_RIGHT,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_UP",        KEY_UP,        JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_DOWN",      KEY_DOWN,      JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_HOME",      KEY_HOME,      JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_END",       KEY_END,       JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_PPAGE",     KEY_PPAGE,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_NPAGE",     KEY_NPAGE,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_F12",       KEY_F(12),     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_RESIZE",    KEY_RESIZE,    JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("KEY_MOUSE",     KEY_MOUSE,     JS_PROP_CONFIGURABLE),
  JS_PROP_INT32_DEF("ERR",           ERR,           JS_PROP_CONFIGURABLE),
  JS_PROP_INT64_DEF("BUTTON1_CLICKED",  BUTTON1_CLICKED,  JS_PROP_CONFIGURABLE),
  JS_PROP_INT64_DEF("BUTTON1_PRESSED",  BUTTON1_PRESSED,  JS_PROP_CONFIGURABLE),
  JS_PROP_INT64_DEF("BUTTON1_RELEASED", BUTTON1_RELEASED, JS_PROP_CONFIGURABLE),
  JS_PROP_INT64_DEF("BUTTON4_PRESSED",  BUTTON4_PRESSED,  JS_PROP_CONFIGURABLE),
  JS_PROP_INT64_DEF("BUTTON5_PRESSED",  BUTTON5_PRESSED,  JS_PROP_CONFIGURABLE),
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
