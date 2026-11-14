export function drawWindow(tui, theme, { x, y, w, h, title, focused, style = 0 }) {
  if (h < 2 || w < 2) return;
  const P = theme.pairs;
  const borderPair = focused ? P.windowBorderFocus : P.windowBorder;
  const titlePair  = focused ? P.windowTitleFocus  : P.windowTitle;

  tui.box(y, x, h, w, borderPair, style);

  if (title && w >= title.length + 6) {
    const label = ' ' + title + ' ';
    const tx = x + 2;
    tui.fillPair(y, tx, 1, label.length, titlePair);
    tui.printPair(y, tx, label, titlePair);
  }
}
