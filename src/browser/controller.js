import { parseUrl }       from 'src/base/url.js';
import { htmlToText }     from 'src/content/html-to-text.js';

const WELCOME =
  'Welcome to QJSBrowser!\n\n' +
  'Type a URL above and press Enter.\n\n' +
  'Keyboard — page mode:\n' +
  '  j / ↓      scroll down\n' +
  '  k / ↑      scroll up\n' +
  '  space      page down\n' +
  '  b          page up\n' +
  '  1-9        follow link N\n' +
  '  [  / ]     back / forward\n' +
  '  r          reload\n' +
  '  g  or :    edit URL\n' +
  '  q          quit\n\n' +
  'Keyboard — omnibox mode:\n' +
  '  Enter      navigate\n' +
  '  Esc        back to page mode\n' +
  '  Ctrl+U     clear line\n' +
  '  Ctrl+W     delete word\n';

export function createController(deps) {
  const { tui, net, keys, epfd, httpClient,
          omnibox, pageView, statusBar, history } = deps;

  let mode = 'omnibox';   // 'omnibox' | 'page'
  let running = true;
  let currentUrl = '';

  // ---------- render ----------
  function render() {
    const { rows, cols } = tui.size();

    tui.attron(tui.A_REVERSE | tui.A_BOLD);
    tui.print(0, 0, ' QJSBrowser ');
    const qh = ' Ctrl+C = quit ';
    tui.print(0, cols - qh.length, qh);
    tui.attroff(tui.A_REVERSE | tui.A_BOLD);

    const { cursorCol } = omnibox.render(tui, 1, cols, mode === 'omnibox');

    tui.move(2, 0); tui.clrtoeol();
    tui.print(2, 0, '─'.repeat(cols));

    const { scrollY, maxScroll } = pageView.render(tui, 3, rows - 4, cols);

    const scrollInfo = maxScroll > 0 ? ` [${scrollY}/${maxScroll}]` : '';
    const hints = mode === 'omnibox'
      ? ' [Enter=goto Esc=page]'
      : ' [j/k:scroll 1-9:link [:back ]:fwd g:goto r:reload q:quit]';
    statusBar.render(tui, rows - 1, cols, scrollInfo + hints);

    if (mode === 'omnibox')
      tui.move(1, Math.min(cursorCol, cols - 1));
    tui.refresh();
  }

  // ---------- input ----------
  function handleInput() {
    let ch;
    while ((ch = tui.getch()) !== keys.ERR) {
      if (ch === keys.CTRL_C) { running = false; return; }
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
    const pageH = rows - 4;

    if (ch === 'g'.charCodeAt(0) || ch === ':'.charCodeAt(0)) {
      mode = 'omnibox'; return;
    }
    if (ch === 'q'.charCodeAt(0)) { running = false; return; }
    if (ch === 'r'.charCodeAt(0)) {
      if (currentUrl) navigate(currentUrl, { fromHistory: true });
      return;
    }
    if (ch === '['.charCodeAt(0)) { goBack();    return; }
    if (ch === ']'.charCodeAt(0)) { goForward(); return; }

    if (ch === 'j'.charCodeAt(0) || ch === keys.ARROW_DOWN) {
      pageView.scroll(1, cols, pageH); return;
    }
    if (ch === 'k'.charCodeAt(0) || ch === keys.ARROW_UP) {
      pageView.scroll(-1, cols, pageH); return;
    }
    if (ch === keys.SPACE) {
      pageView.scroll(Math.max(1, pageH - 2), cols, pageH); return;
    }
    if (ch === 'b'.charCodeAt(0)) {
      pageView.scroll(-Math.max(1, pageH - 2), cols, pageH); return;
    }

    if (ch >= '1'.charCodeAt(0) && ch <= '9'.charCodeAt(0)) {
      const n = ch - '0'.charCodeAt(0);
      const link = pageView.links.find(l => l.n === n);
      if (link) navigate(link.href);
      else      statusBar.set(`No link [${n}]`);
      return;
    }
  }

  // ---------- navigation ----------
  function navigate(url, options = {}) {
    const p = parseUrl(url);
    if (!p) { statusBar.set('Invalid URL: ' + url); render(); return; }
    if (p.scheme !== 'http' && p.scheme !== 'https') {
      statusBar.set('Unsupported scheme: ' + p.scheme + '://');
      render(); return;
    }
    pageView.setContent('Loading ' + url + ' …', []);
    httpClient.fetch(url, { ...options, parsed: p });
  }

  function goBack() {
    const url = history.back();
    if (!url) { statusBar.set('No history back'); render(); return; }
    omnibox.setText(url);
    navigate(url, { fromHistory: true });
  }

  function goForward() {
    const url = history.forward();
    if (!url) { statusBar.set('No history forward'); render(); return; }
    omnibox.setText(url);
    navigate(url, { fromHistory: true });
  }

  // ---------- callbacks from httpClient ----------
  function handleStatus(url, msg) { statusBar.set(msg); render(); }

  function handleError(url, msg) {
    statusBar.set('Error: ' + msg);
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

    let text, links = [];
    if (looksHtml) {
      const parsed = htmlToText(resp.body, url);
      text = parsed.text;
      links = parsed.links;
      if (links.length > 0) {
        text += '\n\n─── Links ───\n';
        for (const l of links) text += `[${l.n}] ${l.href}\n`;
      }
    } else {
      text = resp.body;
    }

    pageView.setContent(text, links);
    statusBar.set(
      `HTTP ${resp.status} ${resp.statusText} — ` +
      `${text.length} chars, ${links.length} links`
    );
    render();
  }

  // ---------- init ----------
  pageView.setContent(WELCOME, []);
  statusBar.set('ready');

  return {
    render, handleInput,
    handleStatus, handleResponse, handleError,
    isRunning: () => running,
  };
}
