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
  const CYAN    = 14;
  const RED     = 9;
  const YELLOW  = 11;
  const GREEN   = 2;
  const MAGENTA = 13;
  const DARK    = numColors >= 256 ? 236 : 8;

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
  pair('link',              BLUE,    DEFAULT);
  pair('visited',           MAGENTA, DEFAULT);
  pair('error',             RED,     DEFAULT);
  pair('warning',           YELLOW,  DEFAULT);
  pair('success',           GREEN,   DEFAULT);

  return { hasColor: true, numColors, pairs: P };
}
