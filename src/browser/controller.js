import { parseUrl }      from 'src/base/url.js';
import { htmlToText }    from 'src/content/html-to-text.js';
import { drawWindow }    from 'src/ui/window.js';
import { createToolbar } from 'src/ui/toolbar.js';

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
  '  q          quit\n\n' +
  'Mouse:\n' +
  '  click ◀ ▶ ⟳ ⌂   toolbar actions\n' +
  '  click address    focus URL bar\n' +
  '  click [N] link   navigate\n' +
  '  wheel up/down    scroll\n';

export function createController(deps) {
  const { tui, net, keys, epfd, httpClient, theme,
          omnibox, pageView, history } = deps;

  const P = theme.pairs;
  const toolbar = createToolbar(tui, theme);

  let mode = 'omnibox';
  let running = true;
  let currentUrl = '';
  let statusText = 'ready';
  let cursorPos = null;

  // ---------- address bar ----------
  function renderAddressBar(x, y, w, focused) {
    const bg = focused ? P.addressFocus : P.address;
    tui.fillPair(y, x, 1, w, bg);

    const text = omnibox.text;
    const cursor = omnibox.cursor;
    const pad = 1;
    const avail = Math.max(1, w - pad * 2);

    let viewStart = 0;
    let viewEnd = text.length;
    if (text.length > avail) {
      if (cursor < avail) {
        viewEnd = avail;
      } else {
        viewStart = cursor - avail + 1;
        viewEnd = cursor + 1;
      }
    }

    const visible = text.slice(viewStart, viewEnd);
    const content = ' '.repeat(pad) + visible;
    const padded = content + ' '.repeat(Math.max(0, w - content.length));
    tui.printPair(y, x, padded.slice(0, w), bg);

    if (focused) {
      const curInView = (cursor >= viewStart && cursor <= viewEnd)
        ? (cursor - viewStart) + pad
        : -1;
      if (curInView >= 0) cursorPos = { y, x: x + curInView };
    }
  }

  // ---------- full screen render ----------
  function render() {
    const { rows, cols } = tui.size();
    cursorPos = null;

    tui.erase();
    drawWindow(tui, theme, { x: 0, y: 0, w: cols, h: rows, title: 'QJSBrowser', focused: true, style: 0 });

    const tbW = cols - 2;
    const tbUsed = toolbar.render(1, 1, tbW, mode);

    const addrX = 1 + tbUsed;
    const addrW = tbW - tbUsed;
    if (addrW > 2) renderAddressBar(addrX, 1, addrW, mode === 'omnibox');

    if (rows > 4) tui.hline(2, 1, cols - 2, P.separator, '─');

    const pageY = 3;
    const pageH = rows - 6;
    if (pageH > 0) pageView.render(1, pageY, cols - 2, pageH);

    if (rows > 5) tui.hline(rows - 3, 1, cols - 2, P.separator, '─');

    if (rows > 4) {
      const stY = rows - 2;
      const stW = cols - 2;
      tui.fillPair(stY, 1, 1, stW, P.status);
      const line = (' ' + statusText).slice(0, stW).padEnd(stW);
      tui.printPair(stY, 1, line, P.status);
    }

    if (mode === 'omnibox' && cursorPos) {
      tui.setCursor(1);
      tui.move(cursorPos.y, Math.min(cursorPos.x, cols - 2));
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
      if (ch === keys.TAB) {
        mode = (mode === 'omnibox') ? 'page' : 'omnibox';
        if (mode === 'omnibox') omnibox.setText(omnibox.text);
        continue;
      }
      if (mode === 'omnibox') handleOmniboxKey(ch);
      else                    handlePageKey(ch);
    }
    render();
  }

  function handleOmniboxKey(ch) {
    if (ch === keys.ESC) { mode = 'page'; return; }
    const res = omnibox.handleKey(ch, keys);
    if (res && res.submitted) {
      const url = res.submitted;
      if (url.length) { mode = 'page'; navigate(url); }
    }
  }

  function handlePageKey(ch) {
    const { rows, cols } = tui.size();
    const pageH = rows - 6;

    if (ch === 'g'.charCodeAt(0) || ch === ':'.charCodeAt(0)) { mode = 'omnibox'; return; }
    if (ch === 'q'.charCodeAt(0)) { running = false; return; }
    if (ch === 'r'.charCodeAt(0)) { if (currentUrl) navigate(currentUrl, { fromHistory: true }); return; }
    if (ch === '['.charCodeAt(0)) { goBack();    return; }
    if (ch === ']'.charCodeAt(0)) { goForward(); return; }

    if (ch === 'j'.charCodeAt(0) || ch === keys.ARROW_DOWN) { pageView.scroll(1, cols - 2, pageH); return; }
    if (ch === 'k'.charCodeAt(0) || ch === keys.ARROW_UP)   { pageView.scroll(-1, cols - 2, pageH); return; }
    if (ch === keys.SPACE) { pageView.scroll(Math.max(1, pageH - 2), cols - 2, pageH); return; }
    if (ch === 'b'.charCodeAt(0)) { pageView.scroll(-Math.max(1, pageH - 2), cols - 2, pageH); return; }

    if (ch >= '1'.charCodeAt(0) && ch <= '9'.charCodeAt(0)) {
      const n = ch - '0'.charCodeAt(0);
      const link = pageView.links.find(l => l.n === n);
      if (link) navigate(link.href);
      else      statusText = `No link [${n}]`;
      return;
    }
  }

  // ---------- mouse ----------
  function handleMouse() {
    const ev = tui.getMouse();
    if (!ev) return;

    const { x, y, bstate } = ev;

    // Wheel scroll (works anywhere)
    if (bstate & tui.BUTTON4_PRESSED) {
      const { cols, rows } = tui.size();
      pageView.scroll(-3, cols - 2, rows - 6);
      return;
    }
    if (bstate & tui.BUTTON5_PRESSED) {
      const { cols, rows } = tui.size();
      pageView.scroll(3, cols - 2, rows - 6);
      return;
    }

    // Left click
    if (!(bstate & (tui.BUTTON1_CLICKED | tui.BUTTON1_PRESSED))) return;

    const hit = toolbar.hitTest(x, y);
    if (hit) {
      if (hit.type === 'address') {
        if (mode !== 'omnibox') {
          mode = 'omnibox';
          omnibox.setText(omnibox.text);
        }
        return;
      }
      if (hit.type === 'button') {
        switch (hit.id) {
          case 'back':    goBack();    break;
          case 'forward': goForward(); break;
          case 'reload':  if (currentUrl) navigate(currentUrl, { fromHistory: true }); break;
          case 'home':    mode = 'omnibox'; omnibox.clear(); break;
        }
        return;
      }
    }

    // Page area click
    const { rows, cols } = tui.size();
    const pageY = 3, pageH = rows - 6, pageX = 1, pageW = cols - 2;
    if (y >= pageY && y < pageY + pageH && x >= pageX && x < pageX + pageW) {
      handlePageClick(x - pageX, y - pageY, pageW);
      return;
    }
  }

  function handlePageClick(relX, relY, pageW) {
    const line = pageView.lineAt(relY, pageW);
    if (!line) { mode = 'page'; return; }

    let cx = 0;
    for (const seg of line) {
      const w = seg.text.length;
      if (w > 0 && relX >= cx && relX < cx + w) {
        if (seg.linkN !== null) {
          const link = pageView.links.find(l => l.n === seg.linkN);
          if (link) { navigate(link.href); return; }
        }
        break;
      }
      cx += w;
    }
    mode = 'page';
  }

  // ---------- navigation ----------
  function navigate(url, options = {}) {
    const p = parseUrl(url);
    if (!p) { statusText = 'Invalid URL: ' + url; render(); return; }
    if (p.scheme !== 'http' && p.scheme !== 'https') {
      statusText = 'Unsupported scheme: ' + p.scheme + '://';
      render(); return;
    }
    pageView.setContent('Loading ' + url + ' …', []);
    httpClient.fetch(url, { ...options, parsed: p });
  }

  function goBack() {
    const url = history.back();
    if (!url) { statusText = 'No history back'; render(); return; }
    omnibox.setText(url);
    navigate(url, { fromHistory: true });
  }

  function goForward() {
    const url = history.forward();
    if (!url) { statusText = 'No history forward'; render(); return; }
    omnibox.setText(url);
    navigate(url, { fromHistory: true });
  }

  // ---------- callbacks from httpClient ----------
  function handleStatus(url, msg) { statusText = msg; render(); }

  function handleError(url, msg) {
    statusText = 'Error: ' + msg;
    pageView.setContent('Failed: ' + url + '\n\n' + msg, []);
    render();
  }


  function handleResponse(url, resp, options) {
    currentUrl = url;
    if (!options.fromHistory) history.push(url);
    else                     history.replace(url);

    omnibox.setText(url);
    mode = 'page';

    const ct = (resp.headers['content-type'] || '').toLowerCase();
    const looksHtml = ct.includes('html') || /^\s*</.test(resp.body);

    let plainLen = 0;
    let linksCount = 0;

    if (looksHtml) {
      const parsed = htmlToText(resp.body, url);
      pageView.setContent(parsed.segments, parsed.links);
      plainLen = parsed.text.length;
      linksCount = parsed.links.length;
    } else {
      pageView.setContent(resp.body, []);
      plainLen = resp.body.length;
    }

    statusText = `HTTP ${resp.status} ${resp.statusText} — ${plainLen} chars, ${linksCount} links`;
    render();
  }

  pageView.setContent(WELCOME, []);

  return {
    render, handleInput,
    handleStatus, handleResponse, handleError,
    isRunning: () => running,
  };
}
