export function createToolbar(tui, theme) {
  const buttons = [
    { id: 'back',    label: '◀' },
    { id: 'forward', label: '▶' },
    { id: 'reload',  label: '⟳' },
    { id: 'home',    label: '⌂' },
  ];

  let focusIndex = -1;

  return {
    buttons,
    setFocus(i) { focusIndex = i; },
    getFocus()  { return focusIndex; },

    render(x, y, w, mode) {
      const P = theme.pairs;
      tui.fillPair(y, x, 1, w, P.toolbar);

      let cx = x + 1;
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        const label = ' ' + b.label + ' ';
        const focused = (mode === 'toolbar' && i === focusIndex);
        const pair = focused ? P.buttonFocus : P.button;
        tui.printPair(y, cx, label, pair);
        cx += label.length;
        tui.printPair(y, cx, ' ', P.toolbar);
        cx += 1;
      }

      tui.printPair(y, cx, '│', P.separator);
      cx += 1;

      return cx - x;
    },
  };
}
