export function createTabBar(tui, theme) {
  let tabRects = [];
  let plusRect = null;
  let menuRect = null;
  let lastRow = -1;

  function tabTitle(url) {
    if (!url) return 'New Tab';
    try {
      const m = url.match(/^https?:\/\/([^\/?#]+)([\/?#][^#]*)?/i);
      if (!m) return url.slice(0, 20);
      const host = m[1];
      const path = (m[2] || '').replace(/\?.*$/, '');
      const full = host + path;
      return full.length > 22 ? full.slice(0, 21) + '…' : full;
    } catch (_) {
      return url.slice(0, 22);
    }
  }

  function render(x, y, w, tabs, activeIndex) {
    const P = theme.pairs;
    tabRects = [];
    plusRect = null;
    menuRect = null;
    lastRow = y;

    tui.fillPair(y, x, 1, w, P.tabBarBg);
    if (tabs.length === 0) return;

    const plusW = 3;
    const menuW = 3;
    const available = w - plusW - menuW;
    const idealTabW = Math.floor(available / tabs.length);
    const tabW = Math.max(8, Math.min(26, idealTabW));

    let cx = x;
    for (let i = 0; i < tabs.length; i++) {
      if (cx + tabW > x + available) break;
      const tab = tabs[i];
      const isActive = i === activeIndex;
      const pair = isActive ? P.tabActive : P.tabInactive;

      tui.fillPair(y, cx, 1, tabW, pair);

      const closeX = cx + tabW - 2;
      const labelStart = cx + 1;
      const labelMax = tabW - 4;
      let label = tabTitle(tab.currentUrl);
      if (tab.loading) label = '⟳ ' + label;
      if (label.length > labelMax) label = label.slice(0, labelMax - 1) + '…';
      label = label.padEnd(labelMax);

      tui.printPair(y, labelStart, label, pair);
      tui.printPair(y, closeX, '×', pair);

      tabRects.push({ x: cx, y, w: tabW, closeX, tabIndex: i });
      cx += tabW;
    }

    if (cx + plusW <= x + w - menuW) {
      tui.fillPair(y, cx, 1, plusW, P.tabPlus);
      tui.printPair(y, cx, ' + ', P.tabPlus);
      plusRect = { x: cx, y, w: plusW };
      cx += plusW;
    }

    if (cx < x + w - menuW) tui.fillPair(y, cx, 1, x + w - menuW - cx, P.tabBarBg);

    /* ★ Menu button (⋮) pinned to the right edge */
    const mx = x + w - menuW;
    tui.fillPair(y, mx, 1, menuW, P.tabBarBg);
    tui.printPair(y, mx, ' ⋮ ', P.tabActive);
    menuRect = { x: mx, y, w: menuW };
  }

  function hitTest(mx, my) {
    if (my !== lastRow) return null;

    if (menuRect && mx >= menuRect.x && mx < menuRect.x + menuRect.w) {
      return { type: 'menu' };
    }

    for (const r of tabRects) {
      if (mx >= r.x && mx < r.x + r.w) {
        if (mx === r.closeX || mx === r.closeX + 1)
          return { type: 'close', index: r.tabIndex };
        return { type: 'activate', index: r.tabIndex };
      }
    }
    if (plusRect && mx >= plusRect.x && mx < plusRect.x + plusRect.w)
      return { type: 'new' };
    return null;
  }

  return { render, hitTest };
}
