export function createPageView(tui, theme) {
  let content = '';
  let scrollY = 0;
  let links = [];
  let cachedLines = null;
  let cachedCols = 0;

  function setContent(text, newLinks) {
    content = text;
    links = newLinks || [];
    scrollY = 0;
    cachedLines = null;
  }

  function layout(cols) {
    if (cachedLines && cachedCols === cols) return cachedLines;
    const out = [];
    for (const line of content.split('\n')) {
      if (line.length <= cols) out.push(line);
      else for (let i = 0; i < line.length; i += cols)
        out.push(line.slice(i, i + cols));
    }
    cachedLines = out;
    cachedCols = cols;
    return out;
  }

  function maxScroll(cols, viewH) {
    return Math.max(0, layout(cols).length - viewH);
  }

  function scroll(dy, cols, viewH) {
    scrollY = Math.max(0, Math.min(scrollY + dy, maxScroll(cols, viewH)));
  }

  function render(x, y, w, h) {
    const P = theme.pairs;
    tui.fillPair(y, x, h, w, P.page);

    const lines = layout(w);
    const ms = Math.max(0, lines.length - h);
    if (scrollY > ms) scrollY = ms;
    if (scrollY < 0)  scrollY = 0;

    for (let i = 0; i < h; i++) {
      const idx = i + scrollY;
      if (idx < lines.length) {
        tui.printPair(y + i, x, lines[idx], P.page);
      }
    }

    return { scrollY, maxScroll: ms };
  }

  /* Get the wrapped line at a given visual row inside the viewport.
   * viewRow is 0-based from the top of the visible page area. */
  function lineAt(viewRow, cols) {
    const lines = layout(cols);
    const idx = scrollY + viewRow;
    if (idx < 0 || idx >= lines.length) return null;
    return lines[idx];
  }

  return {
    setContent, render, scroll, maxScroll, lineAt,
    get links()   { return links; },
    get scrollY() { return scrollY; },
    get raw()     { return content; },
  };
}
