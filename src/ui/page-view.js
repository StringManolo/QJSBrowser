export function createPageView(tui, theme, imageView) {
  let segments = [{ text: '' }];
  let links = [];
  let scrollY = 0;
  let cachedLines = null;
  let cachedCols = 0;

  function setContent(segmentsOrText, newLinks) {
    if (typeof segmentsOrText === 'string') {
      segments = segmentsOrText.length > 0
        ? [{ text: segmentsOrText }]
        : [{ text: '' }];
    } else {
      segments = (segmentsOrText && segmentsOrText.length > 0)
        ? segmentsOrText
        : [{ text: '' }];
    }
    links = newLinks || [];
    scrollY = 0;
    cachedLines = null;
  }

  function invalidate() { cachedLines = null; }

  function pairIdFor(seg) {
    const P = theme.pairs;
    if (seg.pairName && P[seg.pairName] !== undefined) return P[seg.pairName];
    if (seg.linkN !== null && seg.linkN !== undefined) return P.link;
    return P.page;
  }

  function flagsFor(seg) {
    let f = 0;
    if (seg.bold)      f |= tui.A_BOLD;
    if (seg.underline) f |= tui.A_UNDERLINE;
    return f;
  }

  function layout(cols) {
    if (cachedLines && cachedCols === cols) return cachedLines;

    const P = theme.pairs;
    const lines = [[]];
    let col = 0;

    for (const seg of segments) {
      if (seg.type === 'img') {
        if (col > 0) { lines.push([]); col = 0; }
        if (imageView && imageView.has(seg.src)) {
          const cells = imageView.get(seg.src);
          for (let r = 0; r < cells.rows; r++) {
            lines[lines.length - 1].push({ kind: 'img', src: seg.src, rowIdx: r, cols: cells.cols });
            lines.push([]);
          }
        } else {
          const alt = seg.alt || seg.src;
          const pair = P.page;
          lines[lines.length - 1].push({ kind: 'text', text: `[IMG: ${alt}]`, linkN: null, pair, flags: 0 });
          lines.push([]);
        }
        col = 0;
        continue;
      }

      const pair = pairIdFor(seg);
      const flags = flagsFor(seg);
      const text = seg.text || '';
      let i = 0;
      while (i < text.length) {
        const nl = text.indexOf('\n', i);
        const end = nl < 0 ? text.length : nl;
        let chunk = text.slice(i, end);

        while (chunk.length > 0) {
          const remaining = cols - col;
          if (remaining <= 0) { lines.push([]); col = 0; continue; }
          if (chunk.length <= remaining) {
            lines[lines.length - 1].push({ kind: 'text', text: chunk, linkN: seg.linkN, pair, flags });
            col += chunk.length;
            chunk = '';
          } else {
            lines[lines.length - 1].push({ kind: 'text', text: chunk.slice(0, remaining), linkN: seg.linkN, pair, flags });
            chunk = chunk.slice(remaining);
            lines.push([]); col = 0;
          }
        }
        if (nl < 0) break;
        lines.push([]); col = 0; i = nl + 1;
      }
    }

    cachedLines = lines;
    cachedCols = cols;
    return lines;
  }

  function maxScroll(cols, viewH) { return Math.max(0, layout(cols).length - viewH); }
  function scroll(dy, cols, viewH) { scrollY = Math.max(0, Math.min(scrollY + dy, maxScroll(cols, viewH))); }

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
      let cx = x;
      for (const seg of lines[idx]) {
        if (seg.kind === 'img') {
          if (imageView) imageView.renderRow(cx, y + i, seg.src, seg.rowIdx);
          cx += seg.cols;
          break;
        }
        if (!seg.text || seg.text.length === 0) continue;
        tui.printPair(y + i, cx, seg.text, seg.pair, seg.flags || 0);
        cx += seg.text.length;
      }
    }

    return { scrollY, maxScroll: ms };
  }

  function lineAt(viewRow, cols) {
    const lines = layout(cols);
    const idx = scrollY + viewRow;
    if (idx < 0 || idx >= lines.length) return null;
    return lines[idx];
  }

  return {
    setContent, render, scroll, maxScroll, lineAt, invalidate,
    get links()    { return links; },
    get scrollY()  { return scrollY; },
    get segments() { return segments; },
  };
}
