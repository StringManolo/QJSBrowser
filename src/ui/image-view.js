export function createImageView(tui, theme) {
  const cache = new Map();

  /* Compute target cell size.
   *
   * Source pixel → cell mapping:
   *   - 1 cell = 1 pixel wide
   *   - 1 cell = 2 pixels tall (we use '▀' with fg=top, bg=bottom)
   *
   * displayW/displayH (if provided) override the natural pixel size —
   * this matches what HTML `width`/`height` attributes tell us about
   * how large the image should appear on the page.
   *
   * We never UPSCALE: if the target fits within max bounds at natural
   * size, render at natural size. Only shrink when necessary. */
  function decode(rgba, srcW, srcH, maxCols, maxRows, displayW, displayH) {
    let cellCols, cellRows;

    if (displayW > 0 && displayH > 0) {
      cellCols = displayW;
      cellRows = Math.ceil(displayH / 2);
    } else if (displayW > 0) {
      cellCols = displayW;
      cellRows = Math.max(1, Math.round(srcH * displayW / srcW / 2));
    } else if (displayH > 0) {
      cellRows = Math.ceil(displayH / 2);
      cellCols = Math.max(1, Math.round(srcW * displayH / srcH));
    } else {
      /* Natural: 1 cell per source pixel horizontally */
      cellCols = srcW;
      cellRows = Math.ceil(srcH / 2);
    }

    /* Clamp to fit — shrink preserving aspect ratio, never enlarge */
    if (cellCols > maxCols || cellRows > maxRows) {
      const scale = Math.min(maxCols / cellCols, maxRows / cellRows);
      cellCols = Math.max(1, Math.floor(cellCols * scale));
      cellRows = Math.max(1, Math.floor(cellRows * scale));
    }
    if (cellCols < 1) cellCols = 1;
    if (cellRows < 1) cellRows = 1;

    const totalCells = cellCols * cellRows;
    const fg = new Uint32Array(totalCells);
    const bg = new Uint32Array(totalCells);
    const dstH = cellRows * 2;

    /* Nearest-neighbor sampling — correct for 1:1 and downscale, safe for
     * the tiny upscale that can happen if displayW says so. */
    for (let cy = 0; cy < cellRows; cy++) {
      for (let cx = 0; cx < cellCols; cx++) {
        const syTop = Math.floor((cy * 2)     * srcH / dstH);
        const syBot = Math.floor((cy * 2 + 1) * srcH / dstH);
        const sx    = Math.floor(cx           * srcW / cellCols);

        const idxTop = (syTop * srcW + sx) * 4;
        const idxBot = (syBot * srcW + sx) * 4;

        const r1 = rgba[idxTop], g1 = rgba[idxTop + 1], b1 = rgba[idxTop + 2];
        const r2 = rgba[idxBot], g2 = rgba[idxBot + 1], b2 = rgba[idxBot + 2];

        fg[cy * cellCols + cx] = (r1 << 16) | (g1 << 8) | b1;
        bg[cy * cellCols + cx] = (r2 << 16) | (g2 << 8) | b2;
      }
    }

    return { cols: cellCols, rows: cellRows, fg, bg };
  }

  function set(src, rgbaBytes, srcW, srcH, maxCols, maxRows, displayW, displayH) {
    if (!src || !rgbaBytes || rgbaBytes.length === 0) return;
    if (!srcW || !srcH || srcW < 1 || srcH < 1) return;
    if (!maxCols || !maxRows || maxCols < 1 || maxRows < 1) return;
    const cells = decode(rgbaBytes, srcW, srcH, maxCols, maxRows,
                         displayW || 0, displayH || 0);
    cache.set(src, cells);
  }

  function has(src) { return cache.has(src); }
  function get(src) { return cache.get(src); }

  function renderRow(x, y, src, rowIdx) {
    const cells = cache.get(src);
    if (!cells) return false;
    if (rowIdx < 0 || rowIdx >= cells.rows) return false;
    for (let cx = 0; cx < cells.cols; cx++) {
      const idx = rowIdx * cells.cols + cx;
      tui.printRgb(y, x + cx, cells.fg[idx], cells.bg[idx], '▀');
    }
    return true;
  }

  return { set, has, get, renderRow };
}
