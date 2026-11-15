export function createTheme(tui) {
  const numColors = tui.initColors();
  const hasColor = numColors >= 8;

  if (!hasColor) {
    return {
      hasColor: false,
      numColors: 0,
      pairs: new Proxy({}, { get: () => 0 }),
    };
  }

  const P = {};
  let next = 1;
  function pair(name, fg, bg) {
    tui.definePair(next, fg, bg);
    P[name] = next++;
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
  pair('page',              DEFAULT, DEFAULT);
  pair('link',              LINK,    DEFAULT);
  pair('visited',           MAGENTA, DEFAULT);
  pair('error',             RED,     DEFAULT);
  pair('warning',           YELLOW,  DEFAULT);
  pair('success',           GREEN,   DEFAULT);

  pair('tabBarBg',     DIM,             TAB_BAR_BG);
  pair('tabActive',    WHITE,           BLUE);
  pair('tabInactive',  TAB_INACTIVE_FG, TAB_INACTIVE);
  pair('tabPlus',      GREEN,           TAB_PLUS_BG);

  // ---- HTML semantics ----
  // Headings: brightness gradient from h1 (brightest) to h6 (dimmest).
  // The bold attribute is applied separately by the renderer.
  pair('heading1', has256 ? 231 : WHITE, DEFAULT);
  pair('heading2', has256 ? 253 : WHITE, DEFAULT);
  pair('heading3', has256 ? 251 : WHITE, DEFAULT);
  pair('heading4', has256 ? 249 : WHITE, DEFAULT);
  pair('heading5', has256 ? 247 : WHITE, DEFAULT);
  pair('heading6', has256 ? 245 : WHITE, DEFAULT);

  // Inline code and <pre> blocks: warm text on a dark gray background.
  pair('code',       has256 ? 180 : WHITE, has256 ? 235 : DIM);

  // Blockquote: dimmed, indented by the renderer.
  pair('blockquote', has256 ? 244 : DIM, DEFAULT);

  // List bullets / numbers.
  pair('listBullet', has256 ? 220 : YELLOW, DEFAULT);

  return { hasColor: true, numColors, pairs: P };
}
