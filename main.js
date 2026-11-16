import net   from 'network_sockets';
import tui   from 'tui';
import tls   from 'tls';
import image from 'image';
import zlib  from 'zlib';
import fs    from 'fs';
import dns   from 'dns';

import { buildKeyMap }        from 'src/base/keys.js';
import { createScheduler }    from 'src/base/scheduler.js';
import { createTimers }       from 'src/base/timers.js';
import { installGlobals }     from 'src/browser/globals.js';
import { installDomGlobals }  from 'src/browser/dom-globals.js';
import { parseHtmlInto }      from 'src/content/html-to-dom.js';
import { createTheme }        from 'src/ui/theme.js';
import { createConsole }      from 'src/ui/console.js';
import { createImageView }    from 'src/ui/image-view.js';
import { createHttpClient }   from 'src/net/http-client.js';
import { createCookieJar }    from 'src/net/cookies.js';
import { createSettings }     from 'src/browser/settings.js';
import { createTabManager }   from 'src/browser/tab-manager.js';
import { createController }   from 'src/browser/controller.js';
import { Event }              from 'src/dom/events.js';

tui.init();
tui.mouseEnable();

const settings  = createSettings(fs);
settings.load();

const cookieJar = createCookieJar(fs);
cookieJar.load();

const theme      = createTheme(tui);
const keys       = buildKeyMap(tui);
const epfd       = net.epoll_create1(0);
net.epoll_ctl(epfd, net.EPOLL_CTL_ADD, 0, net.EPOLLIN);

const imageView  = createImageView(tui, theme);
const tabManager = createTabManager(tui, theme, imageView);
tabManager.add();

const scheduler  = createScheduler();
const timers     = createTimers();
const httpClient = createHttpClient(net, epfd, tls, cookieJar, zlib, dns);

let devConsole = null;

const realController = createController({
  tui, net, keys, epfd, httpClient, theme, tabManager, imageView,
  settings, cookieJar,
  onToggleConsole: () => {
    if (!devConsole) return;
    const was = devConsole.isVisible();
    devConsole.toggle();
    if (was && !devConsole.isVisible()) redrawAfterConsoleClosed();
  },
});

devConsole = createConsole({ tui, theme });

installGlobals({
  tui,
  timers,
  getUrl: () => {
    try {
      const tab = tabManager.active();
      return (tab && tab.currentUrl) || '';
    } catch (_) { return ''; }
  },
  setUrl: (newUrl, kind) => {
    try {
      const tab = tabManager.active();
      if (!tab) return;

      const target = String(newUrl || '');
      if (!target || target === 'about:blank') return;

      /* pushState/replaceState: silent URL mutation, no event, no fetch.
       * Per spec, only back/forward fire popstate; the caller is
       * responsible for updating the view. */
      if (kind === 'pushstate' || kind === 'replacestate') {
        tab.currentUrl = target;
        try { tab.omnibox.setText(target); } catch (_) {}
        return;
      }

      /* Every other kind goes through navigate(), which detects
       * hash-only changes (dispatch event + push history, no fetch)
       * vs real navigation (fetch + replace on fromHistory). */
      const opts = (kind === 'popstate') ? { fromHistory: true }
                 : (kind === 'reload')   ? { reload: true }
                 : {};
      realController.navigate(tab, target, opts);
    } catch (e) {
      try { console.error('[setUrl] ' + (e && e.message || e)); } catch (_) {}
    }
  },
});

installDomGlobals();

/* DOM extensions that nodes.js and dom-globals.js do NOT provide.
 * Runs AFTER installDomGlobals() so document.createElement exists.
 * See the audit: getBoundingClientRect, focus, blur, click, remove,
 * matches, closest, contains, classList, style.setProperty,
 * createComment, createDocumentFragment, querySelector(All), children
 * are all implemented in src/dom/nodes.js — do NOT duplicate them here. */
(function extendElementPrototype() {
  const doc = globalThis.document;
  if (!doc) return;

  let proto = null;
  try { proto = Object.getPrototypeOf(doc.createElement('div')); } catch (_) {}
  if (!proto) return;

  /* ---- insertAdjacentHTML ---- */
  try {
    if (typeof proto.insertAdjacentHTML !== 'function') {
      proto.insertAdjacentHTML = function (pos, html) {
        const d = this.ownerDocument || doc;
        const scratch = d.createElement('div');
        parseHtmlInto(html, '', d, scratch);
        const nodes = Array.prototype.slice.call(scratch.childNodes || []);
        pos = String(pos).toLowerCase();
        if (pos === 'beforebegin') {
          if (this.parentNode) for (const n of nodes) this.parentNode.insertBefore(n, this);
        } else if (pos === 'afterbegin') {
          const first = this.firstChild;
          for (const n of nodes) this.insertBefore(n, first);
        } else if (pos === 'beforeend') {
          for (const n of nodes) this.appendChild(n);
        } else if (pos === 'afterend') {
          if (this.parentNode) {
            const next = this.nextSibling;
            for (const n of nodes) this.parentNode.insertBefore(n, next);
          }
        } else {
          throw new Error("insertAdjacentHTML: invalid position '" + pos + "'");
        }
      };
    }
  } catch (_) {}

  /* ---- lang / dir reflection ---- */
  try {
    if (!Object.getOwnPropertyDescriptor(proto, 'lang')) {
      Object.defineProperty(proto, 'lang', {
        configurable: true,
        get() { return this.getAttribute ? (this.getAttribute('lang') || '') : ''; },
        set(v) { if (this.setAttribute) this.setAttribute('lang', String(v)); },
      });
    }
  } catch (_) {}
  try {
    if (!Object.getOwnPropertyDescriptor(proto, 'dir')) {
      Object.defineProperty(proto, 'dir', {
        configurable: true,
        get() { return this.getAttribute ? (this.getAttribute('dir') || '') : ''; },
        set(v) { if (this.setAttribute) this.setAttribute('dir', String(v)); },
      });
    }
  } catch (_) {}

  /* ---- window.getComputedStyle ---- */
  try {
    if (typeof globalThis.getComputedStyle !== 'function') {
      globalThis.getComputedStyle = function () {
        return { getPropertyValue: () => '', length: 0 };
      };
    }
  } catch (_) {}

  /* ---- Element.scrollIntoView / scrollTo / scrollBy ---- */
  try {
    if (typeof proto.scrollIntoView !== 'function') proto.scrollIntoView = function () {};
    if (typeof proto.scrollTo       !== 'function') proto.scrollTo       = function () {};
    if (typeof proto.scrollBy       !== 'function') proto.scrollBy       = function () {};
  } catch (_) {}

  /* ---- innerText (dual-path install) ---- */
  const innerTextGet = function () {
    try {
      const tc = this.textContent;
      if (tc !== undefined && tc !== null) return String(tc);
    } catch (_) {}
    let out = '';
    const kids = this.childNodes;
    if (kids && kids.length) {
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (!c) continue;
        if (c.nodeType === 3) out += (c.data || '');
        else if (c.nodeType === 1) {
          try {
            const v = c.textContent;
            if (v != null) out += String(v);
          } catch (_) {}
        }
      }
    }
    return out;
  };
  const innerTextSet = function (v) {
    try {
      const d = this.ownerDocument || doc;
      if (typeof this.removeChild === 'function') {
        while (this.firstChild) this.removeChild(this.firstChild);
      }
      if (typeof this.appendChild === 'function' &&
          d && typeof d.createTextNode === 'function') {
        this.appendChild(d.createTextNode(String(v)));
      }
    } catch (_) {}
  };

  let installed = false;

  if (!Object.getOwnPropertyDescriptor(proto, 'innerText')) {
    try {
      Object.defineProperty(proto, 'innerText', {
        configurable: true,
        enumerable: false,
        get: innerTextGet,
        set: innerTextSet,
      });
      installed = true;
      try { console.log('[dom-patch] innerText: prototype OK'); } catch (_) {}
    } catch (e) {
      try { console.log('[dom-patch] innerText: prototype FAILED — ' +
                        (e && e.message ? e.message : String(e))); } catch (_) {}
    }
  } else {
    installed = true;
    try { console.log('[dom-patch] innerText: prototype already present'); } catch (_) {}
  }

  if (!installed) {
    try {
      if (typeof doc.createElement === 'function' && !doc.createElement.__innerTextPatched) {
        const origCreate = doc.createElement;
        const patched = function (tag, opts) {
          const el = origCreate.call(doc, tag, opts);
          if (el && !('innerText' in el)) {
            try {
              Object.defineProperty(el, 'innerText', {
                configurable: true,
                enumerable: false,
                get: innerTextGet,
                set: innerTextSet,
              });
            } catch (_) {}
          }
          return el;
        };
        patched.__innerTextPatched = true;
        try { doc.createElement = patched; } catch (_) {}
        if (doc.createElement !== patched) {
          try {
            Object.defineProperty(doc, 'createElement', {
              configurable: true, writable: true, value: patched,
            });
          } catch (_) {}
        }
        if (doc.createElement && doc.createElement.__innerTextPatched) {
          installed = true;
          try { console.log('[dom-patch] innerText: createElement hook OK'); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  try {
    const test = doc.createElement('span');
    const ok = test && ('innerText' in test) && typeof test.innerText === 'string';
    try {
      console.log(ok
        ? '[dom-patch] innerText: VERIFIED on fresh element'
        : '[dom-patch] innerText: STILL MISSING on fresh element');
    } catch (_) {}
  } catch (_) {}
})();

/* Redirect console.* to the in-TUI dev console. */
(function hookConsole() {
  const _origClear = console.clear;

  function wrap(kind) {
    return function (...args) {
      try { devConsole.appendOutput(kind, args); } catch (_) {}
    };
  }

  console.log   = wrap('log');
  console.warn  = wrap('log');
  console.info  = wrap('log');
  console.debug = wrap('log');
  console.error = wrap('error');

  console.clear = function (...args) {
    try { if (typeof _origClear === 'function') _origClear.apply(console, args); }
    catch (_) {}
    try { devConsole.clearOutput(); } catch (_) {}
  };
})();

function redrawAfterConsoleClosed() {
  tui.erase();
  try { realController.render(); } catch (_) {}
  if (typeof tui.clearok === 'function') tui.clearok();
  tui.refresh();
}

function closeConsoleAndRedraw() {
  devConsole.toggle();
  if (!devConsole.isVisible()) redrawAfterConsoleClosed();
}

function routeInput() {
  if (devConsole.isVisible()) {
    let ch;
    while ((ch = tui.getch()) !== tui.ERR) {
      devConsole.handleKey(ch);
      if (!devConsole.isVisible()) { redrawAfterConsoleClosed(); return; }
    }
    devConsole.flushPending();
    return;
  }

  const ch = tui.getch();
  if (ch === tui.ERR) return;
  if (ch === tui.KEY_F12) { closeConsoleAndRedraw(); return; }

  if (typeof tui.ungetch !== 'function') {
    console.error('[console] tui.ungetch missing; rebuild lib/tui.so');
    return;
  }
  tui.ungetch(ch);
  realController.handleInput();
}

const controller = {
  ...realController,
  handleInput: routeInput,
  flushRender() {
    realController.flushRender();
    if (devConsole.isVisible()) {
      const sz = tui.size();
      devConsole.render(0, 0, sz.cols, sz.rows);
      tui.refresh();
    }
  },
};

function pumpAndDrain() {
  if (typeof pumpJobs === 'function') {
    try { pumpJobs(200); } catch (e) {
      console.error('[pumpJobs] ' + (e && e.message));
      console.error('[pumpJobs] ' + (e && e.stack));
    }
  }
  const err = globalThis._lastPumpError;
  if (err) {
    globalThis._lastPumpError = '';
    try { devConsole.appendOutput('error', [String(err)]); } catch (_) {}
  }
}

httpClient.setCallbacks({
  onStatus:   (url, msg, opts)  => {
    if (opts && opts.imageFor) return;
    try { controller.handleStatus(opts && opts.tabId, msg); }
    catch (e) { console.log('[onStatus] ' + (e.message || String(e))); }
  },
  onResponse: (url, resp, opts) => {
    const ct = (resp.contentType || resp.headers['content-type'] || '').toLowerCase();
    const isImageResponse = ct.startsWith('image/') ||
                            (opts && opts.binary && opts.imageFor);

    const finish = () => {
      try {
        if (controller.isStale(opts)) return;
        if (isImageResponse && resp.rawBytes) {
          try {
            const decoded = image.decode(resp.rawBytes);
            if (decoded) {
              resp.rawBytes    = decoded.rgba;
              resp.imageWidth  = decoded.width;
              resp.imageHeight = decoded.height;
            }
          } catch (e) { console.log('[image.decode] ' + (e.message || String(e))); }
        }
        controller.handleResponse(opts && opts.tabId, url, resp, opts || {});
      } catch (e) {
        console.log('[onResponse] ' + (e.message || String(e)));
        try { controller.handleError(opts && opts.tabId, url, e.message || String(e), opts); }
        catch (_) {}
      }
    };

    if (isImageResponse && resp.rawBytes) scheduler.defer(finish);
    else finish();
  },
  onError: (url, msg, opts) => {
    if (opts && opts.imageFor) return;
    try { controller.handleError(opts && opts.tabId, url, msg, opts); }
    catch (e) { console.log('[onError] ' + (e.message || String(e))); }
  },
});

controller.render();

while (controller.isRunning()) {
  let timeout = -1;
  if (scheduler.hasWork()) timeout = 0;
  else {
    timeout = controller.msUntilRender();
    if (httpClient.hasJobs() && (timeout < 0 || timeout > 1000)) timeout = 1000;
  }

  const due = timers.nextDue();
  if (due !== Infinity) {
    const ms = Math.max(0, due - Date.now());
    if (timeout < 0 || ms < timeout) timeout = ms;
  }

  let events;
  try { events = net.epoll_wait(epfd, 16, timeout); }
  catch (e) {
    const msg = e.message || String(e);
    if (!/Interrupted system call|EINTR/i.test(msg)) console.error('[epoll_wait] ' + msg);
    continue;
  }

  for (const ev of (events || [])) {
    try {
      if (ev.fd === 0) controller.handleInput();
      else httpClient.onEvent(ev);
    } catch (e) { console.error('[event loop] ' + (e.message || String(e))); }
  }

  try { timers.runDue(Date.now(), 50); }
  catch (e) { console.error('[timers] ' + (e.message || String(e))); }

  pumpAndDrain();

  if (scheduler.hasWork()) {
    try { scheduler.runOne(); }
    catch (e) { console.error('[task] ' + (e.message || String(e))); }
  }

  try { controller.flushRender(); }
  catch (e) { console.error('[render] ' + (e.message || String(e))); }

  try { httpClient.tick(); }
  catch (e) { console.error('[tick] ' + (e.message || String(e))); }
}

cookieJar.save();

tui.mouseDisable();
tui.end();
