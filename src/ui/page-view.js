export function createPageView(tui, theme) {
  let segments = [{ text: '', linkN: null }];
  let links = [];
  let scrollY = 0;
  let cachedLines = null;
  let cachedCols = 0;

  function setContent(segmentsOrText, newLinks) {
    if (typeof segmentsOrText === 'string') {
      segments = segmentsOrText.length > 0
        ? [{ text: segmentsOrText, linkN: null }]
        : [{ text: '', linkN: null }];
    } else {
      segments = (segmentsOrText && segmentsOrText.length > 0)
        ? segmentsOrText
        : [{ text: '', linkN: null }];
    }
    links = newLinks || [];
    scrollY = 0;
    cachedLines = null;
  }

  /* Wrap rich segments into visual lines.
   * Each visual line is an array of { text, linkN, pair }.
   * Wrapping is done per segment so link identity survives across lines. */
  function layout(cols) {
    if (cachedLines && cachedCols === cols) return cachedLines;

    const P = theme.pairs;
    const lines = [[]];
    let col = 0;

    for (const seg of segments) {
      const pair = seg.linkN !== null ? P.link : P.page;
      const text = seg.text;
      let i = 0;
      while (i < text.length) {
        const nl = text.indexOf('\n', i);
        const end = nl < 0 ? text.length : nl;
        let chunk = text.slice(i, end);

        while (chunk.length > 0) {
          const remaining = cols - col;
          if (remaining <= 0) {
            lines.push([]);
            col = 0;
            continue;
          }
          if (chunk.length <= remaining) {
            lines[lines.length - 1].push({ text: chunk, linkN: seg.linkN, pair });
            col += chunk.length;
            chunk = '';
          } else {
            lines[lines.length - 1].push({ text: chunk.slice(0, remaining), linkN: seg.linkN, pair });
            chunk = chunk.slice(remaining);
            lines.push([]);
            col = 0;
          }
        }

        if (nl < 0) break;
        lines.push([]);
        col = 0;
        i = nl + 1;
      }
    }

    cachedLines = lines;
    cachedCols = cols;
    return lines;
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
      if (idx >= lines.length) continue;
      const lineSegs = lines[idx];
      let cx = x;
      for (const seg of lineSegs) {
        if (seg.text.length === 0) continue;
        tui.printPair(y + i, cx, seg.text, seg.pair);
        cx += seg.text.length;
      }
    }

    return { scrollY, maxScroll: ms };
  }

  /* Returns the visual line at viewRow as an array of segments. */
  function lineAt(viewRow, cols) {
    const lines = layout(cols);
    const idx = scrollY + viewRow;
    if (idx < 0 || idx >= lines.length) return null;
    return lines[idx];
  }

  return {
    setContent, render, scroll, maxScroll, lineAt,
    get links()    { return links; },
    get scrollY()  { return scrollY; },
    get segments() { return segments; },
    get raw()      { return segments.map(s => s.text).join(''); },
  };
}
