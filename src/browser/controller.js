import { parseUrl }      from 'src/base/url.js';
import { htmlToText }    from 'src/content/html-to-text.js';
import { drawWindow }    from 'src/ui/window.js';
import { createToolbar } from 'src/ui/toolbar.js';
import { createTabBar }  from 'src/ui/tab-bar.js';

const WELCOME =
  'Welcome to QJSBrowser!\n\n' +
  'Type a URL above and press Enter.\n\n' +
  'Keyboard — page mode:\n' +
  '  j / ↓      scroll down\n' +
  '  k / ↑      scroll up\n' +
  '  Space      page down\n' +
  '  b          page up\n' +
  '  1-9        follow link N\n' +
  '  [  / ]     back / forward\n' +
  '  r          reload\n' +
  '  g / :      edit URL\n' +
  '  Tab        toggle address/page\n' +
  '  Ctrl+T     new tab\n' +
  '  Ctrl+W     close tab\n' +
  '  q          quit\n\n' +
  'Mouse:\n' +
  '  click tab / + / ×    switch / new / close tab\n' +
  '  click ◀ ▶ ⟳ ⌂        toolbar actions\n' +
  '  click address        focus URL bar\n' +
  '  click [N] link       navigate\n' +
  '  wheel up/down        scroll\n';

export function createController(deps) {
  const { tui, net, keys, epfd, httpClient, theme, tabManager } = deps;
  const P = theme.pairs;
  const toolbar = createToolbar(tui, theme);
  const tabBar  = createTabBar(tui, theme);

  let running = true;

  // ---------- address bar renderer ----------
  function renderAddressBar(tab, x, y, w, focused) {
    const bg = focused ? P.addressFocus : P.address;
    tui.fillPair(y, x, 1, w, bg);

    const text = tab.omnibox.text;
    const cursor = tab.omnibox.cursor;
    const pad = 1;
    const avail = Math.max(1, w - pad * 2);

    let viewStart = 0;
    let viewEnd = text.length;
    if (text.length > avail) {
      if (cursor < avail) viewEnd = avail;
      else { viewStart = cursor - avail + 1; viewEnd = cursor + 1; }
    }

    const visible = text.slice(viewStart, viewEnd);
    const content = ' '.repeat(pad) + visible;
    const padded = content + ' '.repeat(Math.max(0, w - content.length));
    tui.printPair(y, x, padded.slice(0, w), bg);

    if (focused) {
      const curInView = (cursor >= viewStart && cursor <= viewEnd)
        ? (cursor - viewStart) + pad
        : -1;
      if (curInView >= 0) tab.cursorPos = { y, x: x + curInView };
    } else {
      tab.cursorPos = null;
    }
  }

  // ---------- full screen render ----------
  function render() {
    const { rows, cols } = tui.size();
    const tab = tabManager.active();
    if (!tab) return;

    tab.cursorPos = null;

    tui.erase();
    drawWindow(tui, theme, { x: 0, y: 0, w: cols, h: rows, title: 'QJSBrowser', focused: true, style: 0 });

    // Tab bar (row 1)
    tabBar.render(1, 1, cols - 2, tabManager.list(), tabManager.activeIndex());

    // Toolbar + address (row 2)
    const tbW = cols - 2;
    const tbUsed = toolbar.render(1, 2, tbW, tab.mode);

    const addrX = 1 + tbUsed;
    const addrW = tbW - tbUsed;
    if (addrW > 2) renderAddressBar(tab, addrX, 2, addrW, tab.mode === 'omnibox');

    // Separator
    if (rows > 5) tui.hline(3, 1, cols - 2, P.separator, '─');

    // Page area
    const pageY = 4;
    const pageH = rows - 7;
    if (pageH > 0) tab.pageView.render(1, pageY, cols - 2, pageH);

    // Bottom separator
    if (rows > 5) tui.hline(rows - 3, 1, cols - 2, P.separator, '─');

    // Status bar
    if (rows > 4) {
      const stY = rows - 2;
      const stW = cols - 2;
      tui.fillPair(stY, 1, 1, stW, P.status);
      const line = (' ' + tab.statusText).slice(0, stW).padEnd(stW);
      tui.printPair(stY, 1, line, P.status);
    }

    // Cursor
    if (tab.mode === 'omnibox' && tab.cursorPos) {
      tui.setCursor(1);
      tui.move(tab.cursorPos.y, Math.min(tab.cursorPos.x, cols - 2));
    } else {
      tui.setCursor(0);
      tui.move(rows - 1, 0);
    }

    tui.refresh();
  }

  // ---------- input ----------
  function handleInput() {
    let ch;
    while ((ch = tui.getch()) !== keys.ERR) {
      if (ch === keys.CTRL_C) { running = false; return; }
      if (ch === keys.KEY_MOUSE) { handleMouse(); continue; }
      if (ch === keys.CTRL_T)    { newTab(); continue; }

      const tab = tabManager.active();
      if (!tab) continue;

      if (ch === keys.TAB) {
        tab.mode = (tab.mode === 'omnibox') ? 'page' : 'omnibox';
        continue;
      }

      if (tab.mode === 'omnibox') {
        handleOmniboxKey(tab, ch);
      } else {
        if (ch === keys.CTRL_W) { closeTab(tabManager.activeIndex()); continue; }
        handlePageKey(tab, ch);
      }
    }
    render();
  }

  function handleOmniboxKey(tab, ch) {
    if (ch === keys.ESC) { tab.mode = 'page'; return; }
    const res = tab.omnibox.handleKey(ch, keys);
    if (res && res.submitted) {
      const url = res.submitted;
      if (url.length) { tab.mode = 'page'; navigate(tab, url); }
    }
  }

  function handlePageKey(tab, ch) {
    const { rows, cols } = tui.size();
    const pageH = rows - 7;

    if (ch === 'g'.charCodeAt(0) || ch === ':'.charCodeAt(0)) { tab.mode = 'omnibox'; return; }
    if (ch === 'q'.charCodeAt(0)) { running = false; return; }
    if (ch === 'r'.charCodeAt(0)) { if (tab.currentUrl) navigate(tab, tab.currentUrl, { fromHistory: true }); return; }
    if (ch === '['.charCodeAt(0)) { goBack(tab);    return; }
    if (ch === ']'.charCodeAt(0)) { goForward(tab); return; }

    if (ch === 'j'.charCodeAt(0) || ch === keys.ARROW_DOWN) { tab.pageView.scroll(1, cols - 2, pageH); return; }
    if (ch === 'k'.charCodeAt(0) || ch === keys.ARROW_UP)   { tab.pageView.scroll(-1, cols - 2, pageH); return; }
    if (ch === keys.SPACE) { tab.pageView.scroll(Math.max(1, pageH - 2), cols - 2, pageH); return; }
    if (ch === 'b'.charCodeAt(0)) { tab.pageView.scroll(-Math.max(1, pageH - 2), cols - 2, pageH); return; }

    if (ch >= '1'.charCodeAt(0) && ch <= '9'.charCodeAt(0)) {
      const n = ch - '0'.charCodeAt(0);
      const link = tab.pageView.links.find(l => l.n === n);
      if (link) navigate(tab, link.href);
      else      tab.statusText = `No link [${n}]`;
      return;
    }
  }

  // ---------- mouse ----------
  function handleMouse() {
    const ev = tui.getMouse();
    if (!ev) return;

    const { x, y, bstate } = ev;
    const { rows, cols } = tui.size();
    const pageH = rows - 7;
    const tab = tabManager.active();

    if (bstate & tui.BUTTON4_PRESSED) {
      if (tab) tab.pageView.scroll(-3, cols - 2, pageH);
      return;
    }
    if (bstate & tui.BUTTON5_PRESSED) {
      if (tab) tab.pageView.scroll(3, cols - 2, pageH);
      return;
    }

    if (!(bstate & (tui.BUTTON1_CLICKED | tui.BUTTON1_PRESSED))) return;

    // Tab bar
    const tabHit = tabBar.hitTest(x, y);
    if (tabHit) {
      if (tabHit.type === 'activate') { tabManager.activate(tabHit.index); render(); }
      else if (tabHit.type === 'close') { closeTab(tabHit.index); }
      else if (tabHit.type === 'new') { newTab(); }
      return;
    }

    if (!tab) return;

    // Toolbar
    const tbHit = toolbar.hitTest(x, y);
    if (tbHit) {
      if (tbHit.type === 'address') {
        if (tab.mode !== 'omnibox') { tab.mode = 'omnibox'; tab.omnibox.setText(tab.omnibox.text); }
        return;
      }
      if (tbHit.type === 'button') {
        switch (tbHit.id) {
          case 'back':    goBack(tab);    break;
          case 'forward': goForward(tab); break;
          case 'reload':  if (tab.currentUrl) navigate(tab, tab.currentUrl, { fromHistory: true }); break;
          case 'home':    tab.mode = 'omnibox'; tab.omnibox.clear(); break;
        }
        return;
      }
    }

    // Page area
    const pageY = 4, pageX = 1, pageW = cols - 2;
    if (y >= pageY && y < pageY + pageH && x >= pageX && x < pageX + pageW) {
      handlePageClick(tab, x - pageX, y - pageY, pageW);
      return;
    }
  }

  function handlePageClick(tab, relX, relY, pageW) {
    const line = tab.pageView.lineAt(relY, pageW);
    if (!line) { tab.mode = 'page'; return; }

    let cx = 0;
    for (const seg of line) {
      const w = seg.text.length;
      if (w > 0 && relX >= cx && relX < cx + w) {
        if (seg.linkN !== null) {
          const link = tab.pageView.links.find(l => l.n === seg.linkN);
          if (link) { navigate(tab, link.href); return; }
        }
        break;
      }
      cx += w;
    }
    tab.mode = 'page';
  }

  // ---------- tab management ----------
  function newTab() {
    const tab = tabManager.add();
    tab.pageView.setContent('New Tab — type a URL above and press Enter.', []);
    render();
  }

  function closeTab(index) {
    if (index < 0) return;
    tabManager.remove(index);
    if (tabManager.count() === 0) { running = false; return; }
    render();
  }

  // ---------- navigation ----------
  function navigate(tab, url, options = {}) {
    const p = parseUrl(url);
    if (!p) { tab.statusText = 'Invalid URL: ' + url; render(); return; }
    if (p.scheme !== 'http' && p.scheme !== 'https') {
      tab.statusText = 'Unsupported scheme: ' + p.scheme + '://';
      render(); return;
    }
    tab.currentUrl = url;
    tab.loading = true;
    tab.omnibox.setText(url);
    tab.pageView.setContent('Loading ' + url + ' …', []);
    httpClient.fetch(url, { ...options, tabId: tab.id });
  }

  function goBack(tab) {
    const url = tab.history.back();
    if (!url) { tab.statusText = 'No history back'; render(); return; }
    tab.omnibox.setText(url);
    navigate(tab, url, { fromHistory: true });
  }

  function goForward(tab) {
    const url = tab.history.forward();
    if (!url) { tab.statusText = 'No history forward'; render(); return; }
    tab.omnibox.setText(url);
    navigate(tab, url, { fromHistory: true });
  }

  // ---------- callbacks from httpClient ----------
  function resolveTab(tabId) {
    if (tabId !== undefined && tabId !== null) {
      const t = tabManager.getById(tabId);
      if (t) return t;
    }
    return tabManager.active();
  }

  function handleStatus(tabId, msg) {
    const tab = resolveTab(tabId);
    if (!tab) return;
    tab.statusText = msg;
    if (tab === tabManager.active()) render();
  }

  function handleError(tabId, url, msg) {
    const tab = resolveTab(tabId);
    if (!tab) return;
    tab.loading = false;
    tab.statusText = 'Error: ' + msg;
    tab.pageView.setContent('Failed: ' + url + '\n\n' + msg, []);
    if (tab === tabManager.active()) render();
  }

  function handleResponse(tabId, url, resp, options) {
    const tab = resolveTab(tabId);
    if (!tab) return;

    tab.loading = false;
    tab.currentUrl = url;
    if (options && options.fromHistory) tab.history.replace(url);
    else                                tab.history.push(url);

    tab.omnibox.setText(url);
    tab.mode = 'page';

    const ct = (resp.headers['content-type'] || '').toLowerCase();
    const looksHtml = ct.includes('html') || /^\s*</.test(resp.body);

    let plainLen = 0, linksCount = 0;
    if (looksHtml) {
      const parsed = htmlToText(resp.body, url);
      tab.pageView.setContent(parsed.segments, parsed.links);
      plainLen = parsed.text.length;
      linksCount = parsed.links.length;
    } else {
      tab.pageView.setContent(resp.body, []);
      plainLen = resp.body.length;
    }

    tab.statusText = `HTTP ${resp.status} ${resp.statusText} — ${plainLen} chars, ${linksCount} links`;
    if (tab === tabManager.active()) render();
  }

  // ---------- init ----------
  const initial = tabManager.active();
  if (initial) {
    initial.pageView.setContent(WELCOME, []);
    initial.statusText = 'ready';
  }

  return {
    render, handleInput,
    handleStatus, handleResponse, handleError,
    isRunning: () => running,
  };
}
