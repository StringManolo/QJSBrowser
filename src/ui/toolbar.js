export function createToolbar(tui, theme) {
  const buttons = [
    { id: 'back',    label: '◀' },
    { id: 'forward', label: '▶' },
    { id: 'reload',  label: '⟳' },
    { id: 'home',    label: '⌂' },
  ];

  let focusIndex = -1;
  let lastButtonRects = [];
  let lastRow = -1;
  let lastAddrX = 0;
  let lastAddrW = 0;

  return {
    buttons,
    setFocus(i) { focusIndex = i; },
    getFocus()  { return focusIndex; },

    render(x, y, w, mode) {
      const P = theme.pairs;
      tui.fillPair(y, x, 1, w, P.toolbar);

      lastRow = y;
      lastButtonRects = [];

      let cx = x + 1;
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        const label = ' ' + b.label + ' ';
        lastButtonRects.push({ x: cx, y, w: label.length, id: b.id });
        const focused = (mode === 'toolbar' && i === focusIndex);
        const pair = focused ? P.buttonFocus : P.button;
        tui.printPair(y, cx, label, pair);
        cx += label.length;
        tui.printPair(y, cx, ' ', P.toolbar);
        cx += 1;
      }

      tui.printPair(y, cx, '│', P.separator);
      cx += 1;

      lastAddrX = cx;
      lastAddrW = x + w - cx;

      return cx - x;
    },

    /* Returns { type: 'button', id } | { type: 'address' } | null */
    hitTest(mx, my) {
      for (const r of lastButtonRects) {
        if (my === r.y && mx >= r.x && mx < r.x + r.w) {
          return { type: 'button', id: r.id };
        }
      }
      if (my === lastRow && lastAddrW > 0 &&
          mx >= lastAddrX && mx < lastAddrX + lastAddrW) {
        return { type: 'address' };
      }
      return null;
    },
  };
}
