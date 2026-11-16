/* Browser-shaped globals that page JS (React, Webpack, Vite, polyfills)
 * touch during bootstrap. No DOM yet — that's PR 2. Idempotent: safe to
 * call twice (checks existence before defining). */
import { resolveUrl } from 'src/base/url.js';
import { Event } from 'src/dom/events.js';


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

function makeLocation(url) {
  url = url || 'about:blank';
  let scheme = 'about', host = '', port = '', path = url;
  const m = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^\/:?#]+)(?::(\d+))?([\/?#].*)?$/i);
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
  return {
    href: url,
    protocol: scheme + ':',
    host: host + (port ? ':' + port : ''),
    hostname: host,
    port,
    pathname: pathOnly,
    search,
    hash,
    origin,
    toString() { return url; },
    assign()  { console.warn('[location] navigation not implemented yet'); },
    replace() { console.warn('[location] navigation not implemented yet'); },
    reload()  { console.warn('[location] reload not implemented yet'); },
  };
}

/* Minimal MessageChannel: enough for React 18's scheduler.
 *
 * Delivery is via microtask rather than setTimeout. With setTimeout, the
 * update is queued for the next timers.runDue() iteration — but the loop
 * may be sleeping in epoll_wait if no fd is readable, delaying the render
 * until the next event. That manifests as "the input field shows what I
 * typed, but Text: stays the old value until I click a button". Microtask
 * delivery happens inside pumpJobs(), which runs immediately before
 * mutation hooks fire and flushRender re-serializes the DOM. */
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

export function installGlobals({ tui, timers, getUrl }) {
  const g = globalThis;

  if (!Object.getOwnPropertyDescriptor(g, 'window')) {
    Object.defineProperty(g, 'window', {
      value: g, configurable: true, writable: false,
    });
  }
  g.self = g;

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

  if (!g.Event) {
  g.Event = Event;
  g.CustomEvent      = Event;
  g.KeyboardEvent    = Event;
  g.MouseEvent       = Event;
  g.FocusEvent       = Event;
  g.InputEvent       = Event;
  g.UIEvent          = Event;
}

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

  if (!g.localStorage)   g.localStorage   = makeStorage();
  if (!g.sessionStorage) g.sessionStorage = makeStorage();

  if (!g.matchMedia) {
    g.matchMedia = (q) => ({
      matches: false,
      media: String(q),
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
    });
  }

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
    this.get    = (k) => this._map.has(k) ? this._map.get(k) : null;
    this.getAll = (k) => this._map.has(k) ? [this._map.get(k)] : [];
    this.set    = (k, v) => { this._map.set(String(k), String(v)); };
    this.has    = (k) => this._map.has(k);
    this.delete = (k) => { this._map.delete(k); };
    this.append = (k, v) => { this._map.set(String(k), String(v)); };
    this.forEach = (cb) => this._map.forEach((v, k) => cb(v, k, this));
    this.toString = () => {
      const parts = [];
      this._map.forEach((v, k) =>
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)));
      return parts.join('&');
    };
  };
}

if (!g.URL) {
  g.URL = function URL(spec, base) {
    if (!(this instanceof g.URL)) return new g.URL(spec, base);
    let href = String(spec);
    if (base !== undefined) href = resolveUrl(String(base), href);
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

  if (!g.MutationObserver) {
  g.MutationObserver = class MutationObserver {
    constructor(callback) { this._cb = callback; }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };

  if (g.document && typeof g.document.querySelectorAll !== 'function') {
  g.document.querySelectorAll = function (sel) {
    const out = [];
    if (!sel || typeof sel !== 'string') return out;
    const m = sel.match(/^([a-z][a-z0-9-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?/i);
    if (!m) return out;
    const tag = (m[1] || '').toLowerCase();
    const id = m[2] || null;
    const cls = m[3] || null;
    function walk(node) {
      if (!node || !node.tagName) {
        if (node && node.childNodes) for (const c of node.childNodes) walk(c);
        return;
      }
      const t = (node.tagName || '').toLowerCase();
      let ok = true;
      if (tag && t !== tag) ok = false;
      if (ok && id && node.getAttribute && node.getAttribute('id') !== id) ok = false;
      if (ok && cls && node.classList && !node.classList.contains(cls)) ok = false;
      if (ok) out.push(node);
      if (node.childNodes) for (const c of node.childNodes) walk(c);
    }
    walk(g.document.body);
    return out;
  };
  g.document.querySelector = function (sel) {
    return g.document.querySelectorAll(sel)[0] || null;
  };
}
}

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

  /* React 18's scheduler uses this to schedule work without polling. */
  if (!g.MessageChannel) g.MessageChannel = MessageChannelPolyfill;

  if (!g.location) {
    Object.defineProperty(g, 'location', {
      configurable: true,
      get() { return makeLocation(getUrl ? getUrl() : ''); },
    });
  }

  if (!g.history) {
    g.history = {
      length: 1,
      state: null,
      pushState(_s, _t, _u) {},
      replaceState(_s, _t, _u) {},
      back() {}, forward() {}, go() {},
    };
  }

  if (!g.hasFocus) g.hasFocus = () => true;

  if (g.console) {
  if (!g.console.error) g.console.error = g.console.warn || g.console.log;
  if (!g.console.warn)  g.console.warn  = g.console.error || g.console.log;
  if (!g.console.info)  g.console.info  = g.console.log;
  if (!g.console.debug) g.console.debug = g.console.log;
  }

  if (g.console && typeof g.console.error === 'function') {
  const origErr = g.console.error.bind(g.console);
  const fmt = (a) => {
    if (a === null || a === undefined) return String(a);
    if (typeof a === 'string') return a;
    if (typeof a === 'object') {
      try {
        if (a.name || a.message)
          return (a.name || 'Error') + ': ' + (a.message || '') +
                 (a.stack ? '\n' + a.stack : '');
        const s = JSON.stringify(a);
        return s && s !== '{}' ? s : Object.prototype.toString.call(a);
      } catch (_) { return String(a); }
    }
    return String(a);
  };
  g.console.error = function (...args) {
    origErr(...args.map(fmt));
  };
}

  /* Patch Element/Node/Document prototypes for React 18 compatibility.
 * React's commit phase calls these on every host component:
 *   getBoundingClientRect, focus, blur, remove, contains,
 *   insertBefore, classList.*, style.setProperty, click,
 *   scrollIntoView, getComputedStyle, createComment, etc.
 * Any missing method manifests as "TypeError: not a function" deep
 * in React's commitRoot, which is impossible to trace from the
 * minified bundle. This block fills the common gaps. */
(function patchDom() {
  const doc = g.document;
  if (!doc) return;

  let probe = null;
  try { probe = doc.createElement('div'); } catch (_) {}
  if (!probe) return;

  const elProto  = Object.getPrototypeOf(probe);
  const nodeProto = elProto ? Object.getPrototypeOf(elProto) : null;
  const docProto = Object.getPrototypeOf(doc);

  function addMissing(proto, name, fn) {
    if (!proto) return;
    if (typeof proto[name] !== 'function') {
      try { proto[name] = fn; } catch (_) {}
    }
  }

  /* --- Element --- */
  addMissing(elProto, 'getBoundingClientRect', function () {
    return { x: 0, y: 0, width: 0, height: 0,
             top: 0, left: 0, right: 0, bottom: 0 };
  });
  addMissing(elProto, 'getClientRects', function () { return []; });
  addMissing(elProto, 'scrollIntoView', function () {});
  addMissing(elProto, 'scrollTo', function () {});
  addMissing(elProto, 'scrollBy', function () {});
  addMissing(elProto, 'focus', function () {
    if (g.document) g.document.activeElement = this;
  });
  addMissing(elProto, 'blur', function () {
    if (g.document && g.document.activeElement === this)
      g.document.activeElement = g.document.body;
  });
  addMissing(elProto, 'click', function () {
    this.dispatchEvent(new g.Event('click',
      { bubbles: true, cancelable: true }));
  });
  addMissing(elProto, 'remove', function () {
    if (this.parentNode) this.parentNode.removeChild(this);
  });
  addMissing(elProto, 'matches', function () { return false; });
  addMissing(elProto, 'closest', function () { return null; });
  addMissing(elProto, 'append', function (...kids) {
    for (const k of kids) this.appendChild(k);
  });
  addMissing(elProto, 'prepend', function (...kids) {
    const first = this.firstChild;
    for (const k of kids) this.insertBefore(k, first);
  });

  /* --- Node --- */
  addMissing(nodeProto, 'contains', function (other) {
    let cur = other;
    while (cur) { if (cur === this) return true; cur = cur.parentNode; }
    return false;
  });

  /* --- classList: full impl if missing --- */
  if (!probe.classList || typeof probe.classList.add !== 'function') {
    const clsStore = new WeakMap();
    function getSet(el) {
      if (!clsStore.has(el)) {
        const cur = (el.getAttribute && el.getAttribute('class')) || '';
        clsStore.set(el, new Set(cur.split(/\s+/).filter(Boolean)));
      }
      return clsStore.get(el);
    }
    function sync(el, s) {
      if (el.setAttribute) el.setAttribute('class', [...s].join(' '));
    }
    const api = {
      add:      function (...names) { const s = getSet(this); names.forEach(n => s.add(n)); sync(this, s); },
      remove:   function (...names) { const s = getSet(this); names.forEach(n => s.delete(n)); sync(this, s); },
      contains: function (n) { return getSet(this).has(n); },
      toggle:   function (n, force) {
        const s = getSet(this); const has = s.has(n);
        const want = force === undefined ? !has : !!force;
        if (want) s.add(n); else s.delete(n);
        sync(this, s); return want;
      },
      item:     function (i) { return [...getSet(this)][i] || null; },
    };
    try {
      Object.defineProperty(elProto, 'classList', {
        configurable: true,
        get() { return api; },
      });
    } catch (_) {}
  }

  /* --- style: setProperty/getPropertyValue if missing --- */
  if (probe.style) {
    addMissing(Object.getPrototypeOf(probe.style), 'setProperty',
      function (k, v) { this[k] = String(v); });
    addMissing(Object.getPrototypeOf(probe.style), 'getPropertyValue',
      function (k) { return String(this[k] || ''); });
    addMissing(Object.getPrototypeOf(probe.style), 'removeProperty',
      function (k) { const old = this[k]; delete this[k]; return old; });
  }

  /* --- Document --- */
  addMissing(docProto, 'createComment', function () {
    return this.createTextNode('');
  });
  addMissing(docProto, 'createDocumentFragment', function () {
    return this.createElement('fragment');
  });
  addMissing(docProto, 'getComputedStyle', function () {
    return { getPropertyValue: () => '', length: 0 };
  });

  /* --- window --- */
  if (!g.getComputedStyle) {
    g.getComputedStyle = function () {
      return { getPropertyValue: () => '', length: 0 };
    };
  }
  if (!g.scrollTo)   g.scrollTo   = function () {};
  if (!g.scrollBy)   g.scrollBy   = function () {};
  if (!g.scroll)     g.scroll     = function () {};
  if (!g.alert)      g.alert      = function () {};
  if (!g.confirm)    g.confirm    = function () { return false; };
  if (!g.prompt)     g.prompt     = function () { return null; };
  if (!g.open)       g.open       = function () { return null; };
})();

  /* --- IntersectionObserver: usado para scroll-detection, lazy load,
 * fade-in animations. React apps lo invocan desde useEffect.
 * Stub: nunca dispara callback. Si la página depende de scroll para
 * mostrar contenido, no aparecerá — pero al menos no crashea. */
if (!g.IntersectionObserver) {
  g.IntersectionObserver = class IntersectionObserver {
    constructor(cb, opts) { this._cb = cb; this.root = null;
                            this.rootMargin = '0px'; this.thresholds = [0]; }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

/* --- ResizeObserver: usado por react-resize-detector, charts, etc. --- */
if (!g.ResizeObserver) {
  g.ResizeObserver = class ResizeObserver {
    constructor(cb) { this._cb = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/* --- requestIdleCallback: usado por React 18 para hidratación no urgente. --- */
if (!g.requestIdleCallback) {
  g.requestIdleCallback = function (cb) {
    return timers.setTimeout(function () {
      try { cb({ didTimeout: false, timeRemaining: () => 50 }); }
      catch (e) { console.error('[rIC] ' + (e && e.message || e)); }
    }, 0);
  };
  g.cancelIdleCallback = function (id) { timers.clearTimeout(id); };
}

/* --- crypto: usado por React DevTools / librerías modernas. --- */
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

/* --- WAAPI: element.animate() es cada vez más común (framer-motion,
 * auto-animate). Stub que devuelve un objeto Animation. --- */
(function patchAnimate() {
  if (!g.document) return;
  let probe;
  try { probe = g.document.createElement('div'); } catch (_) { return; }
  if (!probe) return;
  const proto = Object.getPrototypeOf(probe);
  if (!proto || typeof proto.animate === 'function') return;
  proto.animate = function () {
    return { finished: Promise.resolve(), cancel() {}, play() {},
             pause() {}, finish() {}, onfinish: null };
  };
})();

  /* --- Canvas: Lottie, charts, animaciones. Stub que no dibuja. --- */
(function patchCanvas() {
  if (!g.document) return;
  let canvas;
  try { canvas = g.document.createElement('canvas'); } catch (_) { return; }
  if (!canvas) return;
  const proto = Object.getPrototypeOf(canvas);
  if (!proto || typeof proto.getContext === 'function') return;
  proto.getContext = function () {
    return new Proxy({}, {
      get(_, key) {
        if (key === 'canvas') return canvas;
        if (key === 'measureText') return () => ({ width: 0 });
        if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return () => {};
      },
      set() { return true; },
    });
  };
})();

/* --- Audio: a veces usado para feedback de UI. --- */
if (!g.Audio) {
  g.Audio = class Audio {
    constructor(src) { this.src = src; this.volume = 1; }
    play() { return Promise.resolve(); }
    pause() {}
    load() {}
    addEventListener() {}
  };
}

/* --- history.pushState: SPA routers lo usan en useEffect de montaje. --- */
if (g.history) {
  const h = g.history;
  if (typeof h.pushState !== 'function') h.pushState = function () {};
  if (typeof h.replaceState !== 'function') h.replaceState = function () {};
  if (typeof h.back !== 'function') h.back = function () {};
  if (typeof h.forward !== 'function') h.forward = function () {};
  if (typeof h.go !== 'function') h.go = function () {};
}

/* --- matchMedia con matches reales: framer-motion, tailwind, etc.
 * El stub actual siempre devuelve matches:false, lo que hace que
 * framer-motion elija el path "reduced motion" y a veces llame a
 * APIs que no tenemos. Hacerlo más "real" evita ese path. --- */
if (g.matchMedia) {
  const orig = g.matchMedia;
  g.matchMedia = function (q) {
    const m = orig(q);
    /* prefers-reduced-motion:no-preference es el default "normal".
     * Devolver true aquí hace que libs con animaciones escojan el
     * path con animaciones (que al menos tienen stubs). */
    if (/prefers-reduced-motion\s*:\s*no-preference/.test(q)) m.matches = true;
    return m;
  };
}

  /* --- window as EventTarget.
 *
 * React 18 / SPA routers / analytics scripts do
 *   window.addEventListener('hashchange' | 'popstate' | 'resize' |
 *                           'scroll' | 'load' | 'visibilitychange', cb)
 * on mount. `window` is globalThis, and globalThis has no
 * addEventListener unless we add it — Element.prototype listeners
 * don't help. Without this, the first such useEffect throws
 * "TypeError: not a function" deep in React's commit.
 *
 * Implementation: a minimal per-type listener registry on globalThis.
 * `dispatchEvent` on window is wired so that events dispatched via
 * `globalThis.dispatchEvent(ev)` (e.g. the 'load' event the controller
 * fires after scripts run) reach window listeners too. */
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

/* window.location.hash: makeLocation ya devuelve string para .hash,
 * pero verificamos que getUrl() no retorne undefined al inicio.
 * Si el tab aún no ha navegado, url='' → makeLocation('') → 'about:blank'
 * → path='about:blank', sin '#', hash=''. Seguro. */

  /* --- window.scrollTo: SPA routers (this exact bundle, línea 261) lo
 * llaman desde el useEffect de mount del componente raíz. Sin él,
 * el primer render commitea pero el efecto revienta con "not a function"
 * y React desmonta. No-op es semánticamente correcto: no hay scroll
 * real en un TUI. */
if (!g.scrollTo) g.scrollTo = function () {};
if (!g.scroll)   g.scroll   = function () {};
if (!g.scrollBy) g.scrollBy = function () {};
if (!g.scrollByLines)     g.scrollByLines     = function () {};
if (!g.scrollByPages)     g.scrollByPages     = function () {};
if (!g.scrollToLines)     g.scrollToLines     = function () {};



}
