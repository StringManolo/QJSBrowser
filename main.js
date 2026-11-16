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
});

installDomGlobals();

/* DOM extensions. Must run AFTER installDomGlobals() so document exists.
 *
 * The console.log calls here run BEFORE hookConsole, so they go to
 * stderr (visible in the terminal, prefixed with [js] by the C-side
 * console shim). That is intentional: if a patch fails, we want to see
 * it even when devConsole hasn't been wired up yet.
 *
 * Every patch is guarded by its own try/catch so a single failure cannot
 * prevent the others from installing. */
(function extendElementPrototype() {
  const doc = globalThis.document;
  if (!doc) {
    try { console.log('[dom-patch] no document — aborting'); } catch (_) {}
    return;
  }

  let proto = null;
  try { proto = Object.getPrototypeOf(doc.createElement('div')); } catch (_) {}
  if (!proto) {
    try { console.log('[dom-patch] no element prototype — aborting'); } catch (_) {}
    return;
  }

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

  /* ---- querySelector / querySelectorAll ---- */
  try {
    if (typeof proto.querySelectorAll !== 'function') {
      proto.querySelectorAll = function (sel) {
        const out = [];
        if (!sel || typeof sel !== 'string') return out;
        const m = sel.match(/^([a-z][a-z0-9-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?/i);
        if (!m) return out;
        const wantTag = (m[1] || '').toLowerCase();
        const wantId  = m[2] || null;
        const wantCls = m[3] || null;
        const walk = (n) => {
          if (!n || !n.tagName) return;
          const t = (n.tagName || '').toLowerCase();
          let ok = true;
          if (wantTag && t !== wantTag) ok = false;
          if (ok && wantId  && n.getAttribute && n.getAttribute('id') !== wantId) ok = false;
          if (ok && wantCls && n.classList && !n.classList.contains(wantCls)) ok = false;
          if (ok) out.push(n);
          if (n.childNodes) for (const c of n.childNodes) walk(c);
        };
        if (this.childNodes) for (const c of this.childNodes) walk(c);
        return out;
      };
      proto.querySelector = function (sel) {
        return this.querySelectorAll(sel)[0] || null;
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

  /* ---- prepend ---- */
  try {
    if (typeof proto.prepend !== 'function') {
      proto.prepend = function (...kids) {
        const first = this.firstChild;
        for (const k of kids) this.insertBefore(k, first);
      };
    }
  } catch (_) {}

  /* ---- children ---- */
  try {
    if (!Object.getOwnPropertyDescriptor(proto, 'children')) {
      Object.defineProperty(proto, 'children', {
        configurable: true,
        get() {
          const out = [];
          const list = this.childNodes || [];
          for (let i = 0; i < list.length; i++) {
            const n = list[i];
            if (n && n.nodeType === 1) out.push(n);
          }
          return out;
        },
      });
    }
  } catch (_) {}

  /* ==================================================================
   * innerText — TWO independent install paths, each guarded by its
   * own try/catch, with explicit console.log so we can tell WHICH
   * path (if any) succeeded. The calculator's onClick handler reads
   * e.target.innerText; if it returns undefined the display goes to
   * "0undefined" → NaN on next click. That is the exact bug this fixes.
   * ================================================================== */

  const innerTextGet = function () {
    try {
      const tc = this.textContent;
      if (tc !== undefined && tc !== null) return String(tc);
    } catch (_) {}
    /* textContent missing/empty: walk children directly. */
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
  let installMethod = 'none';

  /* Path 1 — Element.prototype. */
  if (!Object.getOwnPropertyDescriptor(proto, 'innerText')) {
    try {
      Object.defineProperty(proto, 'innerText', {
        configurable: true,
        enumerable: false,
        get: innerTextGet,
        set: innerTextSet,
      });
      installed = true;
      installMethod = 'prototype';
      try { console.log('[dom-patch] innerText: prototype OK'); } catch (_) {}
    } catch (e) {
      try { console.log('[dom-patch] innerText: prototype FAILED — ' +
                        (e && e.message ? e.message : String(e))); } catch (_) {}
    }
  } else {
    /* Already defined (idempotent run, or another module got here first). */
    installed = true;
    installMethod = 'prototype (pre-existing)';
    try { console.log('[dom-patch] innerText: prototype already present'); } catch (_) {}
  }

  /* Path 2 — createElement hook. Only attempted if Path 1 failed. */
  if (!installed) {
    try {
      if (typeof doc.createElement === 'function') {
        if (doc.createElement.__innerTextPatched) {
          installed = true;
          installMethod = 'createElement hook (pre-existing)';
          try { console.log('[dom-patch] innerText: createElement hook already present'); } catch (_) {}
        } else {
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

          /* Try plain assignment first. */
          try { doc.createElement = patched; } catch (_) {}
          /* If assignment didn't stick (getter-only property), define. */
          if (doc.createElement !== patched) {
            try {
              Object.defineProperty(doc, 'createElement', {
                configurable: true,
                writable: true,
                value: patched,
              });
            } catch (_) {}
          }

          if (doc.createElement && doc.createElement.__innerTextPatched) {
            installed = true;
            installMethod = 'createElement hook';
            try { console.log('[dom-patch] innerText: createElement hook OK'); } catch (_) {}
          } else {
            try { console.log('[dom-patch] innerText: createElement hook could not be installed (assignment rejected)'); } catch (_) {}
          }
        }
      }
    } catch (e) {
      try { console.log('[dom-patch] innerText: createElement hook threw — ' +
                        (e && e.message ? e.message : String(e))); } catch (_) {}
    }
  }

  /* Verify on a FRESH element. This is the ground truth. */
  try {
    const test = doc.createElement('span');
    const ok = test && ('innerText' in test) && typeof test.innerText === 'string';
    if (ok) {
      try { console.log('[dom-patch] innerText: VERIFIED on fresh element'); } catch (_) {}
    } else {
      try { console.log('[dom-patch] innerText: STILL MISSING on fresh element (installed=' +
                        installed + ', method=' + installMethod + ')'); } catch (_) {}
    }
  } catch (e) {
    try { console.log('[dom-patch] innerText: verify threw — ' +
                      (e && e.message ? e.message : String(e))); } catch (_) {}
  }
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
