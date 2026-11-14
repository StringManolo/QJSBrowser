export function createPageView() {
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
    const lines = layout(cols);
    return Math.max(0, lines.length - viewH);
  }

  function scroll(dy, cols, viewH) {
    scrollY = Math.max(0, Math.min(scrollY + dy, maxScroll(cols, viewH)));
  }

  function scrollTo(y, cols, viewH) {
    scrollY = Math.max(0, Math.min(y, maxScroll(cols, viewH)));
  }

  function render(tui, topRow, height, cols) {
    const lines = layout(cols);
    const ms = Math.max(0, lines.length - height);
    if (scrollY > ms) scrollY = ms;
    if (scrollY < 0)  scrollY = 0;

    for (let i = 0; i < height; i++) {
      tui.move(topRow + i, 0);
      tui.clrtoeol();
      const idx = i + scrollY;
      if (idx < lines.length) tui.print(topRow + i, 0, lines[idx]);
    }
    return { scrollY, maxScroll: ms };
  }

  return {
    setContent, render, scroll, scrollTo, maxScroll,
    get links()    { return links; },
    get scrollY()  { return scrollY; },
    get raw()      { return content; },
  };
}
