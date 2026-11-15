export function createTheme(tui) {
  const numColors = tui.initColors();
  const hasColor = numColors >= 8;

  if (!hasColor) {
    return {
      hasColor: false, numColors: 0,
      pairs: new Proxy({}, { get: () => 0 }),
      lookupPair: () => 0,
    };
  }

  const P = {};
  let nextPair = 1;
  const MAX_PAIRS = 200;

  function pair(name, fg, bg) {
    if (nextPair >= MAX_PAIRS) return;
    tui.definePair(nextPair, fg, bg);
    P[name] = nextPair++;
  }

  const DEFAULT = -1;
  const DIM     = 8;
  const WHITE   = 15;
  const NAVY    = 4;
  const BLUE    = 12;
  const LINK    = 39;
  const CYAN    = 14;
  const RED     = 9;
  const YELLOW  = 11;
  const GREEN   = 2;
  const MAGENTA = 13;

  const has256 = numColors >= 256;
  const DARK    = has256 ? 236 : DIM;
  const TAB_BAR_BG      = has256 ? 236 : DIM;
  const TAB_INACTIVE    = has256 ? 238 : DIM;
  const TAB_INACTIVE_FG = has256 ? 250 : WHITE;
  const TAB_PLUS_BG     = has256 ? 236 : DIM;

  // ---- UI chrome ----
  pair('window',            DEFAULT, DEFAULT);
  pair('windowBorder',      DIM,     DEFAULT);
  pair('windowBorderFocus', BLUE,    DEFAULT);
  pair('windowTitle',       WHITE,   NAVY);
  pair('windowTitleFocus',  0,       BLUE);
  pair('toolbar',           WHITE,   DARK);
  pair('button',            WHITE,   DIM);
  pair('buttonFocus',       0,       CYAN);
  pair('separator',         DIM,     DEFAULT);
  pair('address',           WHITE,   DARK);
  pair('addressFocus',      0,       WHITE);
  pair('status',            WHITE,   NAVY);
  pair('tabBarBg',          DIM,     TAB_BAR_BG);
  pair('tabActive',         WHITE,   BLUE);
  pair('tabInactive',       TAB_INACTIVE_FG, TAB_INACTIVE);
  pair('tabPlus',           GREEN,   TAB_PLUS_BG);

  // ---- Page content ----
  pair('page',              DEFAULT, DEFAULT);
  pair('link',              LINK,    DEFAULT);
  pair('visited',           MAGENTA, DEFAULT);
  pair('error',             RED,     DEFAULT);
  pair('warning',           YELLOW,  DEFAULT);
  pair('success',           GREEN,   DEFAULT);

  // ---- CSS color pairs: 16 foregrounds × 2 backgrounds (default + gray) ----
  // fg on default background
  for (let i = 0; i < 16; i++) pair('c' + i,     i, DEFAULT);
  // fg on gray background (for inline code, etc.)
  const CODE_BG = has256 ? 235 : DIM;
  for (let i = 0; i < 16; i++) pair('cg' + i,    i, CODE_BG);

  // Lookup cache: "fg|bg" → pairId
  const cache = new Map();
  const cssFg = [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1];

  /* Resolve (fgAnsi, bgAnsi) → pairId. Extends the pre-allocated set as
   * needed, capping at MAX_PAIRS. Falls back to 'page' if exhausted. */
    /* Resolve (fgAnsi, bgAnsi) → pairId. Auto-contrasts when bg is set but fg
   * is default: picks black on bright bg, white on dark bg. Prevents the
   * classic "white text on white background" made invisible by CSS. */
  function lookupPair(fgAnsi, bgAnsi) {
    if (fgAnsi === undefined || fgAnsi === null) fgAnsi = -1;
    if (bgAnsi === undefined || bgAnsi === null) bgAnsi = -1;

    if (bgAnsi >= 0) {
      if (fgAnsi === -1 || fgAnsi === bgAnsi) {
        fgAnsi = bgAnsi >= 8 ? 0 : 15;
      }
    }

    const key = fgAnsi + '|' + bgAnsi;
    if (cache.has(key)) return cache.get(key);

    if (fgAnsi >= 0 && fgAnsi < 16) {
      if (bgAnsi === -1)      { cache.set(key, P['c' + fgAnsi]);  return P['c' + fgAnsi]; }
      if (bgAnsi === CODE_BG) { cache.set(key, P['cg' + fgAnsi]); return P['cg' + fgAnsi]; }
    }

    if (nextPair >= MAX_PAIRS) return P.page;
    tui.definePair(nextPair, fgAnsi, bgAnsi);
    cache.set(key, nextPair);
    return nextPair++;
  }


  return { hasColor: true, numColors, pairs: P, lookupPair };
}
