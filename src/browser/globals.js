/* Browser-shaped globals that page JS (React, Webpack, Vite, polyfills)
 * touch during bootstrap. No DOM here — that's dom-globals.js and
 * nodes.js. Idempotent: safe to call twice.
 *
 * Signature: installGlobals({ tui, timers, getUrl, setUrl })
 *
 *   getUrl() → string    current tab URL (may be '' before navigation)
 *   setUrl(url, kind)    called by window.location setters and
 *                        history.pushState/replaceState. `kind` is one
 *                        of 'hashchange' | 'popstate' | 'pushstate' |
 *                        'replacestate' | 'navigate' | 'reload'. The
 *                        caller (main.js) decides whether to fetch or
 *                        just mutate the URL and fire an event. */

import { Event, CustomEvent } from 'src/dom/events.js';

function makeStorage() {
  const m = new Map();
  return {
    getItem(k) { k = String(k); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(String(k)); },
    clear() { m.clear(); },
    key(i) { const ks = [...m.keys()]; return i >= 0 && i < ks.length ? ks[i] : null; },
    get length() { return m.size; },
  };
}

/* location as a STABLE object (not a getter returning a new instance
 * per access), with dynamic getters reading the current URL and setters
 * delegating to setUrl.
 *
 * Stable, because a getter-per-access made `window.location.hash = 'x'`
 * write to a throwaway object — hash-router SPA buttons were dead. */
function makeLocation(getUrl, setUrl) {
  function cur() {
    try { return getUrl ? (getUrl() || '') : ''; } catch (_) { return ''; }
  }
  function parse(u) {
    u = u || 'about:blank';
    let scheme = 'about', host = '', port = '', path = u;
    const m = u.match(/^([a-z][a-z0-9+.-]*):\/\/([^\/:?#]+)(?::(\d+))?([\/?#].*)?$/i);
    if (m) {
      scheme = m[1].toLowerCase();
      host   = m[2];
      port   = m[3] || '';
      path   = m[4] || '/';
    }
    const pathOnly = path.split('?')[0].split('#')[0] || '/';
    const search   = path.includes('?') ? '?' + path.split('?')[1].split('#')[0] : '';
    const hash     = path.includes('#') ? '#' + path.split('#')[1] : '';
    const origin   = host ? scheme + '://' + host + (port ? ':' + port : '') : 'null';
    return { scheme, host, port, pathOnly, search, hash, origin };
  }
  function notify(newUrl, kind) {
    if (!setUrl) return;
    try { setUrl(String(newUrl), kind); } catch (_) {}
  }

  const loc = {
    get href()     { return cur(); },
    set href(v)    { notify(v, 'navigate'); },
    get protocol() { return parse(cur()).scheme + ':'; },
    get host()     { const p = parse(cur()); return p.host + (p.port ? ':' + p.port : ''); },
    get hostname() { return parse(cur()).host; },
    get port()     { return parse(cur()).port; },
    get origin()   { return parse(cur()).origin; },

    get pathname() { return parse(cur()).pathOnly; },
    set pathname(v) {
      const p = parse(cur());
      const np = String(v).startsWith('/') ? String(v) : '/' + String(v);
      notify(p.origin + np + p.search + p.hash, 'navigate');
    },

    get search()   { return parse(cur()).search; },
    set search(v) {
      const p = parse(cur());
      const sv = String(v || '');
      const ns = sv ? (sv.startsWith('?') ? sv : '?' + sv) : '';
      notify(p.origin + p.pathOnly + ns + p.hash, 'navigate');
    },

    get hash()     { return parse(cur()).hash; },
    set hash(v) {
      const u = cur();
      const base = u.split('#')[0];
      const sv = String(v == null ? '' : v);
      if (!sv || sv === '#') { notify(base, 'hashchange'); return; }
      const nh = sv.startsWith('#') ? sv : '#' + sv;
      notify(base + nh, 'hashchange');
    },

    toString()     { return cur(); },
    assign(v)      { notify(v, 'navigate'); },
    replace(v)     { notify(v, 'navigate'); },
    reload()       { notify(cur(), 'reload'); },
  };
  return loc;
}

/* Minimal MessageChannel for React 18's scheduler. Delivery via
 * microtask so commits land inside pumpJobs(), before the mutation
 * hook fires and flushRender re-serializes. */
class MessageChannelPolyfill {
  constructor() {
    this.port1 = { onmessage: null, postMessage: null, start() {}, close() {} };
    this.port2 = { onmessage: null, postMessage: null, start() {}, close() {} };
    const p1 = this.port1, p2 = this.port2;
    p2.postMessage = (data) => {
      Promise.resolve().then(() => {
        if (p1.onmessage) {
          try { p1.onmessage({ data }); }
          catch (e) { console.error('[MessageChannel] ' + (e && e.message || e)); }
        }
      });
    };
    p1.postMessage = (data) => {
      Promise.resolve().then(() => {
        if (p2.onmessage) {
          try { p2.onmessage({ data }); }
          catch (e) { console.error('[MessageChannel] ' + (e && e.message || e)); }
        }
      });
    };
  }
}

export function installGlobals({ tui, timers, getUrl, setUrl }) {
  const g = globalThis;

  /* ---------------- window / self ---------------- */
  if (!Object.getOwnPropertyDescriptor(g, 'window')) {
    Object.defineProperty(g, 'window', {
      value: g, configurable: true, writable: false,
    });
  }
  g.self = g;

  /* ---------------- navigator ---------------- */
  if (!g.navigator) {
    g.navigator = {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) QJSBrowser/0.1',
      appName: 'Netscape',
      appVersion: '5.0 (X11; Linux x86_64)',
      platform: 'Linux x86_64',
      language: 'es-ES',
      languages: ['es-ES', 'es', 'en'],
      onLine: true,
      cookieEnabled: true,
      hardwareConcurrency: 1,
    };
  }

  /* ---------------- viewport ---------------- */
  function readSize() {
    try { return tui.size(); } catch (_) { return { rows: 24, cols: 80 }; }
  }
  Object.defineProperty(g, 'innerWidth',  { configurable: true, get() { return readSize().cols; } });
  Object.defineProperty(g, 'innerHeight', { configurable: true, get() { return readSize().rows; } });
  Object.defineProperty(g, 'outerWidth',  { configurable: true, get() { return readSize().cols; } });
  Object.defineProperty(g, 'outerHeight', { configurable: true, get() { return readSize().rows; } });
  Object.defineProperty(g, 'devicePixelRatio', { value: 1, configurable: true });
  Object.defineProperty(g, 'scrollX', { value: 0, configurable: true });
  Object.defineProperty(g, 'scrollY', { value: 0, configurable: true });
  Object.defineProperty(g, 'pageXOffset', { value: 0, configurable: true });
  Object.defineProperty(g, 'pageYOffset', { value: 0, configurable: true });

  /* ---------------- performance ---------------- */
  if (!g.performance) {
    const t0 = Date.now();
    g.performance = {
      timeOrigin: t0,
      now() { return Date.now() - t0; },
      mark() {}, measure() {},
      clearMarks() {}, clearMeasures() {},
      getEntriesByName() { return []; },
      getEntriesByType() { return []; },
      getEntries() { return []; },
    };
  }

  /* ---------------- storage ---------------- */
  if (!g.localStorage)   g.localStorage   = makeStorage();
  if (!g.sessionStorage) g.sessionStorage = makeStorage();

  /* ---------------- matchMedia ----------------
   * No document access — safe here, unlike Element patches.
   *
   * prefers-reduced-motion:no-preference → matches:true. Many libs
   * (Framer Motion, Tailwind, CSS-in-JS) branch on this. Returning
   * false for everything pushes them to the reduced-motion path,
   * which sometimes calls APIs we don't have. Returning true selects
   * the animated path, where all the calls are guarded stubs. */
  if (!g.matchMedia) {
    g.matchMedia = (q) => {
      const m = {
        matches: false,
        media: String(q),
        addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
      };
      if (/prefers-reduced-motion\s*:\s*no-preference/.test(String(q))) {
        m.matches = true;
      }
      return m;
    };
  }

  /* ---------------- timers ---------------- */
  g.setTimeout    = timers.setTimeout;
  g.setInterval   = timers.setInterval;
  g.clearTimeout  = timers.clearTimeout;
  g.clearInterval = timers.clearInterval;

  if (!g.requestAnimationFrame) {
    g.requestAnimationFrame = (fn) => {
      return timers.setTimeout(() => {
        try { fn(g.performance.now()); }
        catch (e) { console.error('[rAF] ' + (e && e.message ? e.message : String(e))); }
      }, 16);
    };
    g.cancelAnimationFrame = (id) => timers.clearTimeout(id);
  }

  if (!g.queueMicrotask) {
    g.queueMicrotask = (fn) => { Promise.resolve().then(fn); };
  }

  if (!g.MessageChannel) g.MessageChannel = MessageChannelPolyfill;

  /* ---------------- location ---------------- */
  if (!g.location) {
    const loc = makeLocation(getUrl, setUrl);
    try {
      Object.defineProperty(g, 'location', {
        configurable: true,
        writable: false,
        value: loc,
      });
    } catch (_) {
      g.location = loc;
    }
  }

  /* ---------------- history ---------------- */
  if (!g.history) {
    g.history = {
      length: 1,
      state: null,
      pushState(_state, _title, url) {
        if (setUrl && url) {
          try { setUrl(String(url), 'pushstate'); } catch (_) {}
        }
      },
      replaceState(_state, _title, url) {
        if (setUrl && url) {
          try { setUrl(String(url), 'replacestate'); } catch (_) {}
        }
      },
      back() {}, forward() {}, go() {},
    };
  }

  /* ---------------- misc ---------------- */
  if (!g.hasFocus) g.hasFocus = () => true;

  if (g.console) {
    if (!g.console.error) g.console.error = g.console.warn || g.console.log;
    if (!g.console.warn)  g.console.warn  = g.console.error || g.console.log;
    if (!g.console.info)  g.console.info  = g.console.log;
    if (!g.console.debug) g.console.debug = g.console.log;
  }

  /* ---------------- DOM Event constructors ---------------- */
  if (!g.Event)         g.Event         = Event;
  if (!g.CustomEvent)   g.CustomEvent   = CustomEvent;
  if (!g.KeyboardEvent) g.KeyboardEvent = Event;
  if (!g.MouseEvent)    g.MouseEvent    = Event;
  if (!g.FocusEvent)    g.FocusEvent    = Event;
  if (!g.InputEvent)    g.InputEvent    = Event;
  if (!g.UIEvent)       g.UIEvent       = Event;

  /* ---------------- MutationObserver (Vite modulepreload polyfill) ---------------- */
  if (!g.MutationObserver) {
    g.MutationObserver = class MutationObserver {
      constructor(callback) { this._cb = callback; }
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  /* ---------------- URL / URLSearchParams (Vite chunk loaders) ---------------- */
  if (!g.URLSearchParams) {
    g.URLSearchParams = function URLSearchParams(init) {
      if (!(this instanceof g.URLSearchParams)) return new g.URLSearchParams(init);
      this._map = new Map();
      if (typeof init === 'string') {
        const s = init.startsWith('?') ? init.slice(1) : init;
        if (s) {
          for (const pair of s.split('&')) {
            if (!pair) continue;
            const eq = pair.indexOf('=');
            const k = eq < 0 ? pair : pair.slice(0, eq);
            const v = eq < 0 ? '' : pair.slice(eq + 1);
            this._map.set(decodeURIComponent(k),
                          decodeURIComponent(v.replace(/\+/g, ' ')));
          }
        }
      } else if (init && typeof init === 'object') {
        for (const k of Object.keys(init)) this._map.set(k, String(init[k]));
      }
    };
    const P = g.URLSearchParams.prototype;
    P.get    = function (k) { return this._map.has(k) ? this._map.get(k) : null; };
    P.getAll = function (k) { return this._map.has(k) ? [this._map.get(k)] : []; };
    P.set    = function (k, v) { this._map.set(String(k), String(v)); };
    P.has    = function (k) { return this._map.has(k); };
    P.delete = function (k) { this._map.delete(k); };
    P.append = function (k, v) { this._map.set(String(k), String(v)); };
    P.forEach = function (cb) { this._map.forEach((v, k) => cb(v, k, this)); };
    P.toString = function () {
      const parts = [];
      this._map.forEach((v, k) =>
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)));
      return parts.join('&');
    };
  }

  if (!g.URL) {
    g.URL = function URL(spec, base) {
      if (!(this instanceof g.URL)) return new g.URL(spec, base);
      let href = String(spec);
      if (base !== undefined) {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          try {
            const b = new g.URL(base);
            const origin = b.protocol + '//' + b.host;
            if (href.startsWith('/')) href = origin + href;
            else if (href.startsWith('#')) href = origin + b.pathname + b.search + href;
            else if (href.startsWith('?')) href = origin + b.pathname + href;
            else {
              const dir = b.pathname.substring(0, b.pathname.lastIndexOf('/') + 1);
              const parts = (dir + href).split('/');
              const stack = [];
              for (const p of parts) {
                if (p === '..') stack.pop();
                else if (p !== '.' && p !== '') stack.push(p);
              }
              href = origin + '/' + stack.join('/');
            }
          } catch (_) {}
        }
      }
      this.href = href;
      const m = href.match(/^([a-z][a-z0-9+.-]*):\/\/([^\/:?#]+)(?::(\d+))?([\/?#][^#]*)?(#.*)?$/i);
      if (m) {
        this.protocol = m[1].toLowerCase() + ':';
        this.hostname = m[2];
        this.port     = m[3] || '';
        this.host     = m[2] + (m[3] ? ':' + m[3] : '');
        const pathQ   = m[4] || '/';
        const qi      = pathQ.indexOf('?');
        this.pathname = qi >= 0 ? pathQ.slice(0, qi) : pathQ;
        this.search   = qi >= 0 ? pathQ.slice(qi) : '';
        this.hash     = m[5] || '';
        this.origin   = this.protocol + '//' + this.host;
      } else {
        this.protocol = ''; this.hostname = ''; this.port = '';
        this.host     = ''; this.pathname = href; this.search = '';
        this.hash     = ''; this.origin   = 'null';
      }
      this.searchParams = new g.URLSearchParams(this.search);
      this.toString = function () { return this.href; };
    };
  }

  /* ---------------- window.scroll* (SPA routers on mount) ---------------- */
  if (!g.scrollTo) g.scrollTo = function () {};
  if (!g.scroll)   g.scroll   = function () {};
  if (!g.scrollBy) g.scrollBy = function () {};
  if (!g.scrollToLines) g.scrollToLines = function () {};
  if (!g.scrollByLines) g.scrollByLines = function () {};
  if (!g.scrollByPages) g.scrollByPages = function () {};

  /* ---------------- IntersectionObserver / ResizeObserver ---------------- */
  if (!g.IntersectionObserver) {
    g.IntersectionObserver = class IntersectionObserver {
      constructor(cb) { this._cb = cb; this.root = null; this.rootMargin = '0px'; this.thresholds = [0]; }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }
  if (!g.ResizeObserver) {
    g.ResizeObserver = class ResizeObserver {
      constructor(cb) { this._cb = cb; }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  /* ---------------- requestIdleCallback (React 18 hydration) ---------------- */
  if (!g.requestIdleCallback) {
    g.requestIdleCallback = function (cb) {
      return timers.setTimeout(function () {
        try { cb({ didTimeout: false, timeRemaining: () => 50 }); }
        catch (e) { console.error('[rIC] ' + (e && e.message || e)); }
      }, 0);
    };
    g.cancelIdleCallback = function (id) { timers.clearTimeout(id); };
  }

  /* ---------------- crypto ---------------- */
  if (!g.crypto) {
    g.crypto = {
      randomUUID() {
        let s = '';
        for (let i = 0; i < 32; i++) {
          s += ((Math.random() * 16) | 0).toString(16);
          if (i === 7 || i === 11 || i === 15 || i === 19) s += '-';
        }
        return s;
      },
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++)
          arr[i] = (Math.random() * 256) | 0;
        return arr;
      },
    };
  }

  /* ---------------- window as EventTarget ---------------- */
  if (typeof g.addEventListener !== 'function') {
    const _windowListeners = Object.create(null);

    g.addEventListener = function (type, cb) {
      if (!type || typeof cb !== 'function') return;
      (_windowListeners[type] || (_windowListeners[type] = [])).push(cb);
    };
    g.removeEventListener = function (type, cb) {
      const arr = _windowListeners[type];
      if (!arr) return;
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
    g.dispatchEvent = function (ev) {
      if (!ev || !ev.type) return true;
      const arr = _windowListeners[ev.type];
      if (arr) {
        for (const cb of arr.slice()) {
          try { cb(ev); }
          catch (e) {
            console.error('[window listener ' + ev.type + '] ' +
                          (e && e.message || e));
          }
        }
      }
      return !ev.defaultPrevented;
    };
  }
}
