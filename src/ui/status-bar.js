export function createStatusBar() {
  let message = 'ready';

  function set(m) { message = m; }

  function render(tui, row, cols, hints) {
    tui.move(row, 0); tui.clrtoeol();
    tui.attron(tui.A_REVERSE);
    let full = message + hints;
    if (full.length > cols) full = full.slice(0, cols);
    tui.print(row, 0, full);
    tui.attroff(tui.A_REVERSE);
  }

  return { set, render, get message() { return message; } };
}
