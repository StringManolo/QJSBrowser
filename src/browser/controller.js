import { parseUrl }       from 'src/base/url.js';
import { htmlToDom }      from 'src/content/html-to-dom.js';
import { domToText }      from 'src/content/dom-to-text.js';
import { runScripts }     from 'src/content/script-runner.js';
import { resetDocument, setReadyState } from 'src/browser/dom-globals.js';
import { setMutationHook, beginMutationBatch, endMutationBatch } from 'src/dom/mutation-hook.js';
import { Event }          from 'src/dom/events.js';
import { drawWindow }     from 'src/ui/window.js';
import { createToolbar }  from 'src/ui/toolbar.js';
import { createTabBar }   from 'src/ui/tab-bar.js';
import { createSettingsDialog } from 'src/ui/settings-dialog.js';

const WELCOME =
  'Welcome to QJSBrowser!\n\n' +
  'Type a URL above and press Enter.\n\n' +
  'Keyboard — page mode:\n' +
  '  j/k/Space/b    scroll\n' +
  '  1-9            follow link\n' +
  '  [ / ]          back/forward\n' +
  '  r              reload\n' +
  '  x              stop loading\n' +
  '  Tab            next form field (then omnibox)\n' +
  '  Enter          submit form / press focused button\n' +
  '  Esc            blur focused field\n' +
  '  q              quit\n\n' +
  'Click ⋮ in the top-right for Settings.';

export function createController(deps) {
  const { tui, net, keys, epfd, httpClient, theme, tabManager, imageView, settings, cookieJar } = deps;
  const P = theme.pairs;
  const toolbar = createToolbar(tui, theme);
  const tabBar  = createTabBar(tui, theme);

  const dialog = createSettingsDialog(
    tui, theme, settings, cookieJar, tabManager,
    () => {
      let total = 0;
      for (const t of tabManager.list()) {
        total += t.history.length;
        t.history.clear();
      }
      return total;
    },
    deps.onToggleConsole || null,
    (msg) => {
      const tab = tabManager.active();
      if (!tab) return;
      tab.statusText = msg;
      requestRender();
    }
  );

  /* window.fetch — SPA routes call it to load JSON / chunks. Handles:
   *   - absolute URL         http(s)://...        → as-is
   *   - protocol-relative    //host/path          → prepend current scheme
   *   - absolute path        /api/foo             → origin + path
   *   - relative path        ./data/foo, data/foo → resolve against page dir
   *   - hash-only            #frag                → same page
   *
   * Without resolution, '/writeups/foo.json' fed to parseUrl() returns
   * null (no scheme/host), the httpClient errors with 'Invalid URL',
   * and the SPA shows its generic "Error loading ..." message — which
   * is exactly what stringmanolo.qzz.io did when clicking a writeup
   * card. */
  if (!globalThis.fetch) {
    globalThis.fetch = (input, init) => {
      let rawUrl;
      if (typeof input === 'string') rawUrl = input;
      else if (input && typeof input.url === 'string') rawUrl = input.url;
      else rawUrl = String(input);

      let url = rawUrl;
      try {
        const loc = globalThis.location;
        const base = (loc && loc.href) || '';
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
          if (url.startsWith('//')) {
            const scheme = (base.match(/^([a-z][a-z0-9+.-]*):/i) || [])[1] || 'https';
            url = scheme + ':' + url;
          } else if (url.startsWith('/')) {
            const m = base.match(/^([a-z][a-z0-9+.-]*:\/\/[^\/]+)/i);
            url = (m ? m[1] : '') + url;
          } else if (url.startsWith('#')) {
            url = base.split('#')[0] + url;
          } else {
            try {
              if (typeof globalThis.URL === 'function') {
                url = new globalThis.URL(url, base).href;
              } else {
                const b = base.split('#')[0].split('?')[0];
                const dir = b.substring(0, b.lastIndexOf('/') + 1);
                const parts = (dir + url).split('/');
                const stack = [];
                for (const p of parts) {
                  if (p === '..') stack.pop();
                  else if (p !== '.' && p !== '') stack.push(p);
                }
                const origin = (base.match(/^([a-z][a-z0-9+.-]*:\/\/[^\/]+)/i) || [])[1] || '';
                url = origin + '/' + stack.join('/');
              }
            } catch (_) {}
          }
        }
      } catch (_) {}

      const opts = init || {};
      const method = (opts.method || 'GET').toUpperCase();
      const body = (opts.body !== undefined && opts.body !== null)
                   ? String(opts.body) : null;

      try { console.log('[fetch] ' + method + ' ' + url); } catch (_) {}

      return httpClient.fetchPromise(url, { method, body }).then(({ resp }) => {
        const h = resp.headers || {};
        try { console.log('[fetch] → ' + resp.status + ' ' + url); } catch (_) {}

        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          statusText: resp.statusText || '',
          url,
          headers: {
            get: (n) => h[String(n).toLowerCase()] || null,
            has: (n) => String(n).toLowerCase() in h,
            forEach: (cb) => Object.entries(h).forEach(([k, v]) => cb(v, k)),
          },
          text: () => Promise.resolve(resp.body || ''),
          json: () => new Promise((resolve, reject) => {
            try { resolve(JSON.parse(resp.body)); }
            catch (e) { reject(new SyntaxError('Invalid JSON from ' + url + ': ' + e.message)); }
          }),
          arrayBuffer: () => Promise.resolve(
            resp.rawBytes ? resp.rawBytes.buffer : new ArrayBuffer(0)),
          blob: () => Promise.reject(new Error('fetch().blob() not supported')),
          clone() { return this; },
        };
      }).catch((e) => {
        try { console.error('[fetch] FAILED ' + url + ': ' + (e && e.message || e)); } catch (_) {}
        throw e;
      });
    };
  }

  let running = true;
  let domOwner = { tabId: null, navId: 0 };

  setMutationHook(() => {
    const tab = tabManager.active();
    if (!tab) return;
    if (domOwner.tabId !== tab.id || domOwner.navId !== tab.navId) return;
    tab.domDirty = true;
    requestRender();
  });

  const MIN_RENDER_MS = 60;
  let dirty = false;
  let lastRender = 0;
  function requestRender() { dirty = true; }
  function msUntilRender() {
    if (!dirty) return -1;
    return Math.max(0, lastRender + MIN_RENDER_MS - Date.now());
  }
  function flushRender() {
    if (!(dirty && Date.now() - lastRender >= MIN_RENDER_MS)) return;
    render();
  }

  function refreshTabFromDom(tab) {
    tab.domDirty = false;

    const formSnapshot = new Map();
    for (const el of tab.formState.elements.values()) {
      if (el.name && (el.kind === 'text' || el.kind === 'password' || el.kind === 'textarea')) {
        formSnapshot.set(el.name + '|' + el.kind, el.value);
      }
    }
    const focused = tab.formState.getFocused();
    const focusCursor = focused ? tab.formState.cursorPos() : 0;

    const activeNode = (typeof globalThis.document !== 'undefined')
      ? globalThis.document.activeElement
      : null;

    tab.formState.reset();
    const newNodes = new Map();
    const parsed = domToText(
      globalThis.document.body, tab.currentUrl, theme, tab.formState,
      tab._css || [], newNodes
    );
    tab.domNodes = newNodes;
    tab.pageView.updateContent(parsed.segments, parsed.links);

    for (const el of tab.formState.elements.values()) {
      if (el.name && (el.kind === 'text' || el.kind === 'password' || el.kind === 'textarea')) {
        const key = el.name + '|' + el.kind;
        if (formSnapshot.has(key)) el.value = formSnapshot.get(key);
      }
    }

    let restored = false;
    if (activeNode && activeNode !== globalThis.document.body) {
      for (const [id, node] of newNodes) {
        if (node === activeNode) {
          const el = tab.formState.get(id);
          if (el && (el.kind === 'text' || el.kind === 'password' || el.kind === 'textarea')) {
            tab.formState.focus(id);
            tab.formState.moveCursorTo(focusCursor);
            restored = true;
          }
          break;
        }
      }
    }
    if (!restored && focused && focused.name) {
      for (const [id, el] of tab.formState.elements) {
        if (el.name === focused.name && el.kind === focused.kind) {
          tab.formState.focus(id);
          tab.formState.moveCursorTo(focusCursor);
          break;
        }
      }
    }
  }

  function isStale(options) {
    if (!options || options.navId === undefined) return false;
    const t = tabManager.getById(options.tabId);
    return !t || t.navId !== options.navId;
  }

  function renderAddressBar(tab, x, y, w, focused) {
    const bg = focused ? P.addressFocus : P.address;
    tui.fillPair(y, x, 1, w, bg);
    const text = tab.omnibox.text;
    const cursor = tab.omnibox.cursor;
    const pad = 1;
    const avail = Math.max(1, w - pad * 2);
    let viewStart = 0, viewEnd = text.length;
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
        ? (cursor - viewStart) + pad : -1;
      if (curInView >= 0) tab.cursorPos = { y, x: x + curInView };
    } else {
      tab.cursorPos = null;
    }
  }

  function render() {
    dirty = false;
    lastRender = Date.now();
    const { rows, cols } = tui.size();
    const tab = tabManager.active();
    if (!tab) return;

    if (tab.domDirty && domOwner.tabId === tab.id && domOwner.navId === tab.navId) {
      refreshTabFromDom(tab);
    } else {
      tab.domDirty = false;
    }

    tab.cursorPos = null;
    tui.erase();
    tui.maybeClearok();

    drawWindow(tui, theme, { x: 0, y: 0, w: cols, h: rows, title: 'QJSBrowser', focused: true, style: 0 });
    tabBar.render(1, 1, cols - 2, tabManager.list(), tabManager.activeIndex());

    const tbW = cols - 2;
    const tbUsed = toolbar.render(1, 2, tbW, tab.mode);
    const addrX = 1 + tbUsed;
    const addrW = tbW - tbUsed;
    if (addrW > 2) renderAddressBar(tab, addrX, 2, addrW, tab.mode === 'omnibox');

    if (rows > 5) tui.hline(3, 1, cols - 2, P.separator, '─');

    const pageY = 4;
    const pageH = rows - 7;
    if (pageH > 0) tab.pageView.render(1, pageY, cols - 2, pageH);

    if (rows > 5) tui.hline(rows - 3, 1, cols - 2, P.separator, '─');

    if (rows > 4) {
      const stY = rows - 2;
      const stW = cols - 2;
      tui.fillPair(stY, 1, 1, stW, P.status);
      const line = (' ' + tab.statusText).slice(0, stW).padEnd(stW);
      tui.printPair(stY, 1, line, P.status);
    }

    dialog.render(rows, cols);

    let cursorY = rows - 1, cursorX = 0;
    if (!dialog.isOpen() && tab.mode === 'omnibox' && tab.cursorPos) {
      tui.setCursor(1);
      cursorY = tab.cursorPos.y;
      cursorX = Math.min(tab.cursorPos.x, cols - 2);
      tui.move(cursorY, cursorX);
    } else {
      tui.setCursor(0);
      tui.move(cursorY, cursorX);
    }

    tui.refresh();

    if (!dialog.isOpen()) {
      tui.flushImages(cursorY, cursorX);
    }
  }

  function handleInput() {
    let ch;
    while ((ch = tui.getch()) !== keys.ERR) {
      if (ch === keys.CTRL_C) { running = false; return; }
      if (ch === keys.KEY_MOUSE) { handleMouse(); continue; }

      if (dialog.isOpen()) {
        dialog.handleKey(ch, keys);
        continue;
      }

      if (ch === keys.CTRL_T) { newTab(); continue; }

      const tab = tabManager.active();
      if (!tab) continue;

      if (ch === keys.TAB) {
        if (tab.mode === 'omnibox') {
          tab.mode = 'page';
        } else {
          const nextId = tab.formState.tabNext(1);
          if (nextId) {
            tab.formState.focus(nextId);
            focusNodeFor(tab, nextId);
            tab.pageView.invalidate();
          }
          else tab.mode = 'omnibox';
        }
        continue;
      }

      if (tab.mode === 'omnibox') handleOmniboxKey(tab, ch);
      else {
        if (ch === keys.CTRL_W) { closeTab(tabManager.activeIndex()); continue; }
        handlePageKey(tab, ch);
      }
    }

    if (typeof pumpJobs === 'function') {
      try { pumpJobs(200); } catch (_) {}
    }
    render();
  }

  function focusNodeFor(tab, elementId) {
    const node = tab.domNodes && tab.domNodes.get(elementId);
    if (node && typeof node.focus === 'function') {
      try { node.focus(); } catch (_) {}
    }
  }

  function setNativeProp(node, prop, value) {
    const proto = Object.getPrototypeOf(node);
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, prop) : null;
    if (desc && typeof desc.set === 'function') {
      desc.set.call(node, value);
    } else {
      node[prop] = value;
    }
  }

  function syncNodeFromFormState(tab, elementId) {
    const el = tab.formState.get(elementId);
    const node = tab.domNodes && tab.domNodes.get(elementId);
    if (!el || !node) return;
    if (node.value !== el.value) {
      setNativeProp(node, 'value', el.value);
      node.dispatchEvent(new Event('input', { bubbles: true, cancelable: false }));
    }
  }

  function handleOmniboxKey(tab, ch) {
    if (ch === keys.ESC) { tab.mode = 'page'; return; }
    const res = tab.omnibox.handleKey(ch, keys);
    if (res && res.submitted) {
      const url = res.submitted;
      if (url.length) {
        if (!/^(https?:\/\/|localhost|\d+\.\d+\.\d+\.\d+)/i.test(url) &&
            !/^[\w-]+\.[\w.-]+/.test(url)) {
          const engine = settings.SEARCH_ENGINES[settings.get('searchEngine')]
                       || settings.SEARCH_ENGINES.duckduckgo;
          const target = engine.url.replace('%s', encodeURIComponent(url));
          tab.mode = 'page';
          navigate(tab, target);
          return;
        }
        tab.mode = 'page';
        navigate(tab, url);
      }
    }
  }

  function handlePageKey(tab, ch) {
    const { rows, cols } = tui.size();
    const pageH = rows - 7;
    const fs = tab.formState;
    const focusedId = fs.focusedIdOf();
    const focused = focusedId ? fs.get(focusedId) : null;

    if (focused && (focused.kind === 'text' || focused.kind === 'password')) {
      if (ch === keys.ESC) { fs.blur(); tab.pageView.invalidate(); return; }
      if (ch === keys.ARROW_LEFT)  { fs.moveCursor(-1); tab.pageView.invalidate(); return; }
      if (ch === keys.ARROW_RIGHT) { fs.moveCursor(1);  tab.pageView.invalidate(); return; }
      if (ch === keys.HOME)        { fs.moveCursorTo(0); tab.pageView.invalidate(); return; }
      if (ch === keys.END)         { fs.moveCursorTo(9999); tab.pageView.invalidate(); return; }
      if (ch === keys.BACKSPACE || ch === keys.NC_BACKSP || ch === keys.BACKSPACE2) {
        if (fs.backspace()) {
          syncNodeFromFormState(tab, focusedId);
          tab.pageView.invalidate();
        }
        return;
      }
      if (ch === keys.DELETE) {
        if (fs.del()) {
          syncNodeFromFormState(tab, focusedId);
          tab.pageView.invalidate();
        }
        return;
      }
      if (ch === keys.ENTER || ch === keys.ENTER2 || ch === keys.NC_ENTER) {
        const node = tab.domNodes && tab.domNodes.get(focusedId);
        if (node) {
          const ev = new Event('keydown', { bubbles: true, cancelable: true });
          ev.key = 'Enter';
          node.dispatchEvent(ev);
          if (ev._handled) return;
        }
        submitForm(tab);
        return;
      }
      if (ch >= 32 && ch < 127) {
        if (fs.type(String.fromCharCode(ch))) {
          syncNodeFromFormState(tab, focusedId);
          tab.pageView.invalidate();
        }
        return;
      }
    }

    if (ch === 'g'.charCodeAt(0) || ch === ':'.charCodeAt(0)) { tab.mode = 'omnibox'; return; }
    if (ch === 'q'.charCodeAt(0)) { running = false; return; }
    if (ch === 'r'.charCodeAt(0)) { if (tab.currentUrl) navigate(tab, tab.currentUrl, { reload: true }); return; }
    if (ch === 'x'.charCodeAt(0)) { stopLoading(tab); return; }
    if (ch === '['.charCodeAt(0)) { goBack(tab);    return; }
    if (ch === ']'.charCodeAt(0)) { goForward(tab); return; }
    if (ch === keys.ESC) { if (focusedId) { fs.blur(); tab.pageView.invalidate(); } return; }

    if (ch === 'j'.charCodeAt(0) || ch === keys.ARROW_DOWN) { tab.pageView.scroll(1, cols - 2, pageH); return; }
    if (ch === 'k'.charCodeAt(0) || ch === keys.ARROW_UP)   { tab.pageView.scroll(-1, cols - 2, pageH); return; }
    if (ch === keys.SPACE) { tab.pageView.scroll(Math.max(1, pageH - 2), cols - 2, pageH); return; }
    if (ch === 'b'.charCodeAt(0)) { tab.pageView.scroll(-Math.max(1, pageH - 2), cols - 2, pageH); return; }

    if (ch >= '1'.charCodeAt(0) && ch <= '9'.charCodeAt(0)) {
      const n = ch - '0'.charCodeAt(0);
      const link = tab.pageView.links.find(l => l.n === n);
      if (link) navigate(tab, link.href);
      else tab.statusText = `No link [${n}]`;
      return;
    }
  }

  function handleMouse() {
    const ev = tui.getMouse();
    if (!ev) return;
    const { x, y, bstate } = ev;
    const { rows, cols } = tui.size();
    const pageH = rows - 7;
    const tab = tabManager.active();

    if (dialog.isOpen()) {
      if (bstate & (tui.BUTTON1_CLICKED | tui.BUTTON1_PRESSED)) {
        dialog.handleMouseClick(x, y);
      }
      return;
    }

    if (bstate & tui.BUTTON4_PRESSED) { if (tab) tab.pageView.scroll(-3, cols - 2, pageH); return; }
    if (bstate & tui.BUTTON5_PRESSED) { if (tab) tab.pageView.scroll(3,  cols - 2, pageH); return; }
    if (!(bstate & (tui.BUTTON1_CLICKED | tui.BUTTON1_PRESSED))) return;

    const tabHit = tabBar.hitTest(x, y);
    if (tabHit) {
      if (tabHit.type === 'activate') { tabManager.activate(tabHit.index); render(); }
      else if (tabHit.type === 'close') { closeTab(tabHit.index); }
      else if (tabHit.type === 'new') { newTab(); }
      else if (tabHit.type === 'menu') { dialog.open(); render(); }
      return;
    }
    if (!tab) return;

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
          case 'reload':  if (tab.currentUrl) navigate(tab, tab.currentUrl, { reload: true }); break;
          case 'home':    openHome(tab); break;
        }
        return;
      }
    }

    const pageY = 4, pageX = 1, pageW = cols - 2;
    if (y >= pageY && y < pageY + pageH && x >= pageX && x < pageX + pageW) {
      handlePageClick(tab, x - pageX, y - pageY, pageW);
      return;
    }
  }

  function handlePageClick(tab, relX, relY, pageW) {
  const line = tab.pageView.lineAt(relY, pageW);
  if (!line) {
    tab.mode = 'page';
    tab.formState.blur();
    tab.pageView.invalidate();
    return;
  }

  let cx = 0;
  for (const seg of line) {
    if (seg.kind === 'img') {
      /* Image segments can carry a synthetic link for click-through
       * (registered in pushImage). Handle both real links and node
       * dispatch just like text below. */
      if (seg.linkN !== null && seg.linkN !== undefined) {
        const link = tab.pageView.links.find(l => l.n === seg.linkN);
        if (link) {
          if (link.href) { navigate(tab, link.href); return; }
          if (link.node) {
            try {
              const ev = new Event('click', { bubbles: true, cancelable: true });
              link.node.dispatchEvent(ev);
            } catch (_) {}
            return;
          }
        }
      }
      cx += seg.cols;
      continue;
    }

    const w = (seg.text || '').length;
    if (w > 0 && relX >= cx && relX < cx + w) {
      /* Case 1: form control. */
      if (seg.elementId && tab.formState.get(seg.elementId)) {
        activateFormElement(tab, seg.elementId);
        return;
      }

      /* Case 2: link (real or synthetic).
       *
       * linkN survives pageView.lineAt() (text segments that had
       * elementId lose it because lineAt reconstructs the object;
       * linkN is preserved because it's used for rendering). That's
       * why the "Read full writeup →" <div onClick> cards work: they
       * have a synthetic link {href:null, node:<innermost>} registered
       * at domToText time, and clicking dispatches a real DOM click on
       * the node, which bubbles to the React onClick ancestor and
       * navigates. */
      if (seg.linkN !== null && seg.linkN !== undefined) {
        const link = tab.pageView.links.find(l => l.n === seg.linkN);
        if (link) {
          if (link.href) {
            navigate(tab, link.href);
            return;
          }
          if (link.node && typeof link.node.dispatchEvent === 'function') {
            try {
              const ev = new Event('click', { bubbles: true, cancelable: true });
              link.node.dispatchEvent(ev);
            } catch (_) {}
            return;
          }
        }
      }

      /* Case 3: no link, no form — plain text. Blur any focus and stop. */
      break;
    }
    cx += w;
  }

  tab.formState.blur();
  tab.pageView.invalidate();
  tab.mode = 'page';
} 

  function activateFormElement(tab, elementId) {
    const el = tab.formState.get(elementId);
    if (!el) return;
    const node = tab.domNodes && tab.domNodes.get(elementId);

    if (el.kind === 'checkbox' || el.kind === 'radio') {
      if (node) {
        if (el.kind === 'checkbox') {
          setNativeProp(node, 'checked', !node.checked);
        } else {
          const group = el.name;
          if (group) {
            for (const [id2, n2] of tab.domNodes) {
              if (id2 === elementId) continue;
              const el2 = tab.formState.get(id2);
              if (el2 && el2.kind === 'radio' && el2.name === group) {
                if (n2 && n2.checked !== undefined) setNativeProp(n2, 'checked', false);
              }
            }
          }
          setNativeProp(node, 'checked', true);
        }
        const ev = new Event('click', { bubbles: true, cancelable: true });
        node.dispatchEvent(ev);
        if (!ev._handled) {
          tab.formState.toggle(elementId);
        }
        tab.pageView.invalidate();
        return;
      }
      tab.formState.toggle(elementId);
      tab.pageView.invalidate();
      return;
    }

    if (el.kind === 'submit' || el.kind === 'button' || el.kind === 'reset') {
      if (node) {
        const ev = new Event('click', { bubbles: true, cancelable: true });
        node.dispatchEvent(ev);
        if (ev._handled) {
          tab.pageView.invalidate();
          return;
        }
      }
      if (el.kind === 'submit') submitForm(tab, el);
      else if (el.kind === 'reset') resetForm(tab, el);
      tab.pageView.invalidate();
      return;
    }

    tab.formState.focus(elementId);
    focusNodeFor(tab, elementId);
    tab.pageView.invalidate();
  }

  function submitForm(tab, buttonEl) {
    const fs = tab.formState;
    const focusedId = fs.focusedIdOf() || (buttonEl && buttonEl.id);
    if (!focusedId) return;
    const form = fs.findForm(focusedId);
    if (!form) { tab.statusText = 'No form to submit'; return; }
    const collected = fs.collect(form.id);
    if (!collected) return;

    if (collected.method === 'GET') {
      const target = collected.action +
        (collected.action.includes('?') ? '&' : '?') + collected.data;
      navigate(tab, target);
    } else {
      navigate(tab, collected.action, { method: 'POST', body: collected.data });
    }
  }

  function resetForm(tab, el) {
    const form = tab.formState.findForm(el.id);
    if (!form) return;
    for (const fe of tab.formState.elements.values()) {
      if (fe.formId !== form.id) continue;
      if (fe.kind === 'text' || fe.kind === 'password' || fe.kind === 'textarea') fe.value = '';
      if (fe.kind === 'checkbox' || fe.kind === 'radio') fe.checked = false;
    }
    tab.pageView.invalidate();
  }

  function openHome(tab) {
    const home = settings.get('homepage');
    if (home) navigate(tab, home);
    else {
      tab.currentUrl = '';
      tab.pageView.setContent(WELCOME, []);
      tab.omnibox.clear();
      tab.mode = 'omnibox';
      tab.statusText = 'New Tab';
      tab.domNodes = null;
    }
  }

  function newTab() {
    const tab = tabManager.add();
    const home = settings.get('homepage');
    if (home) {
      navigate(tab, home);
    } else {
      tab.pageView.setContent('New Tab — type a URL above and press Enter.', []);
      render();
    }
  }

  function closeTab(index) {
    if (index < 0) return;
    const closing = tabManager.list()[index];
    if (closing) httpClient.abortTab(closing.id);
    tabManager.remove(index);
    if (tabManager.count() === 0) { running = false; return; }
    render();
  }

  function navigate(tab, url, options = {}) {
    const p = parseUrl(url);
    if (!p) { tab.statusText = 'Invalid URL: ' + url; render(); return; }
    if (p.scheme !== 'http' && p.scheme !== 'https') {
      tab.statusText = 'Unsupported scheme: ' + p.scheme + '://';
      render(); return;
    }

    if (!options.reload) {
      const oldBase = (tab.currentUrl || '').split('#')[0];
      const newBase = url.split('#')[0];
      if (oldBase === newBase) {
        tab.currentUrl = url;
        try { tab.omnibox.setText(url); } catch (_) {}

        if (options.fromHistory) {
          Promise.resolve().then(() => {
            try { globalThis.dispatchEvent(new Event('popstate',   { bubbles: false })); } catch (_) {}
            try { globalThis.dispatchEvent(new Event('hashchange', { bubbles: false })); } catch (_) {}
          });
        } else {
          try { tab.history.push(url); } catch (_) {}
          Promise.resolve().then(() => {
            try { globalThis.dispatchEvent(new Event('hashchange', { bubbles: false })); } catch (_) {}
          });
        }
        requestRender();
        return;
      }
    }

    httpClient.abortTab(tab.id);
    tab.navId++;

    tab.currentUrl = url;
    tab.loading = true;
    tab.formState.blur();
    tab.formState.reset();
    tab.domDirty = false;
    tab.domNodes = null;
    tab.omnibox.setText(url);
    tab.pageView.setContent('Loading ' + url + ' …', []);
    httpClient.fetch(url, { ...options, tabId: tab.id, navId: tab.navId });
  }

  function stopLoading(tab) {
    httpClient.abortTab(tab.id);
    if (tab.loading) {
      tab.loading = false;
      tab.statusText = 'Stopped';
      tab.pageView.setContent('Stopped loading ' + tab.currentUrl, []);
    } else {
      tab.statusText = 'Stopped loading images';
    }
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
    if (tab === tabManager.active()) requestRender();
  }

  function handleError(tabId, url, msg, opts) {
    if (opts && opts._promise) {
      try { opts._promise.reject(new Error(msg)); } catch (_) {}
      return;
    }
    const tab = resolveTab(tabId);
    if (!tab) return;
    tab.loading = false;
    tab.statusText = 'Error: ' + msg;
    tab.pageView.setContent('Failed: ' + url + '\n\n' + msg, []);
    if (tab === tabManager.active()) render();
  }

  function executePageScripts(tab, scripts, url) {
    const startNavId = tab.navId;
    const isStale = () => tab.navId !== startNavId;

    setReadyState('interactive');

    runScripts(scripts, { tab, url, httpClient })
      .then(() => {
        if (isStale()) return;
        try {
          globalThis.document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
        } catch (e) { console.error('[DOMContentLoaded] ' + e); }
        return new Promise(r => setTimeout(r, 0));
      })
      .then(() => {
        if (isStale()) return;
        setReadyState('complete');
        try {
          globalThis.dispatchEvent(new Event('load'));
        } catch (e) { console.error('[load] ' + e); }
      })
      .catch((e) => {
        if (!isStale()) console.error('[execute-page-scripts] ' + (e && e.stack || String(e)));
      });
  }

  function handleResponse(tabId, url, resp, options) {
    if (options && options._promise) {
      try { options._promise.resolve({ url, resp, options }); } catch (_) {}
      return;
    }

    if (options && options.binary && options.imageFor) {
      const tab = tabManager.getById(options.imageFor);
      if (!tab) return;
      if (!resp.rawBytes || !resp.imageWidth || !resp.imageHeight) return;
      const { rows, cols } = tui.size();
      imageView.set(options.imageSrc, resp.rawBytes,
                    resp.imageWidth, resp.imageHeight,
                    cols - 2, Math.max(4, rows - 7),
                    options.displayW || 0, options.displayH || 0);
      tab.pageView.invalidate();
      if (tab === tabManager.active()) requestRender();
      return;
    }

    const tab = resolveTab(tabId);
    if (!tab) return;

    const ct = (resp.headers['content-type'] || '').toLowerCase();

    if (ct.startsWith('image/')) {
      tab.loading = false;
      tab.currentUrl = url;
      if (options && options.fromHistory) tab.history.replace(url);
      else tab.history.push(url);
      tab.omnibox.setText(url);
      tab.mode = 'page';
      if (resp.rawBytes && resp.imageWidth && resp.imageHeight) {
        const { rows, cols } = tui.size();
        imageView.set(url, resp.rawBytes, resp.imageWidth, resp.imageHeight,
                      cols - 2, Math.max(4, rows - 7), 0, 0);
        tab.pageView.setContent([{ type: 'img', src: url, alt: url }], []);
        tab.statusText = `Image ${resp.imageWidth}×${resp.imageHeight} — ${url}`;
      } else {
        const fmt = (ct.match(/^image\/([a-z0-9+.-]+)/) || [])[1] || 'unknown';
        let msg = `Image: ${url}\n\nFormat: ${fmt}\nSize: ${resp.rawBytes ? resp.rawBytes.length : 0} bytes\n`;
        if (fmt === 'svg+xml') msg += '\nSVG images are not rendered.';
        tab.pageView.setContent(msg, []);
        tab.statusText = `Image (${fmt}) — not rendered`;
      }
      if (tab === tabManager.active()) render();
      return;
    }

    tab.loading = false;
    tab.currentUrl = url;
    if (options && options.fromHistory) tab.history.replace(url);
    else tab.history.push(url);
    tab.omnibox.setText(url);
    tab.mode = 'page';

    const looksHtml = ct.includes('html') || /^\s*</.test(resp.body);
    let plainLen = 0, linksCount = 0, imagesCount = 0;

    if (looksHtml) {
      tab.formState.reset();

      let css = [];
      let scripts = [];
      beginMutationBatch();
      try {
        resetDocument();
        const result = htmlToDom(resp.body, url, globalThis.document);
        css = result.css;
        scripts = result.scripts;
        domOwner = { tabId: tab.id, navId: tab.navId };
      } finally {
        endMutationBatch();
      }

      tab._css = css;
      tab.domNodes = new Map();
      const parsed = domToText(
        globalThis.document.body, url, theme, tab.formState, css, tab.domNodes
      );
      tab.domDirty = false;
      tab.pageView.setContent(parsed.segments, parsed.links);
      plainLen = parsed.text.length;
      linksCount = parsed.links.length;
      imagesCount = parsed.images.length;

      if (settings.get('showImages')) {
        const requested = new Set();
        for (const img of parsed.images) {
          if (imageView.has(img.src)) continue;
          if (requested.has(img.src)) continue;
          if (/\.svg(\?|#|$)/i.test(img.src)) continue;
          requested.add(img.src);
          httpClient.fetch(img.src, {
            tabId: tab.id, navId: tab.navId, binary: true, imageFor: tab.id,
            imageSrc: img.src, displayW: img.width || 0, displayH: img.height || 0,
            redirectCount: 0,
          });
        }
      }

      if (scripts.length > 0) executePageScripts(tab, scripts, url);
      else {
        setReadyState('interactive');
        setTimeout(() => {
          if (tab.navId !== domOwner.navId) return;
          try { globalThis.document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true })); } catch (_) {}
          setReadyState('complete');
          try { globalThis.dispatchEvent(new Event('load')); } catch (_) {}
        }, 0);
      }
    } else {
      tab.pageView.setContent(resp.body, []);
      plainLen = resp.body.length;
      domOwner = { tabId: null, navId: 0 };
      tab.domNodes = null;
    }

    tab.statusText = `HTTP ${resp.status} ${resp.statusText} — ${plainLen} chars, ${linksCount} links, ${imagesCount} images`;
    if (tab === tabManager.active()) render();
  }

  const initial = tabManager.active();
  if (initial) {
    const home = settings.get('homepage');
    if (home) navigate(initial, home);
    else {
      initial.pageView.setContent(WELCOME, []);
      initial.statusText = 'ready';
    }
  }

  return {
    render, handleInput,
    handleStatus, handleResponse, handleError,
    requestRender, flushRender, msUntilRender, isStale,
    isRunning: () => running,
    navigate,
  };
}
