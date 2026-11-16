/* Browser-shaped globals that page JS (React, Webpack, Vite, polyfills)
 * touch during bootstrap. No DOM yet — that's PR 2. */

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
  const origin   = host ? scheme + '://' + host + (port ? ':' + port : '') : 'null';
  return {
    href: url,
    protocol: scheme + ':',
    host: host + (port ? ':' + port : ''),
    hostname: host,
    port,
    pathname: pathOnly,
    search,
    hash: '',
    origin,
    toString() { return url; },
    assign() {},
    replace() {},
    reload() {},
  };
}

export function installGlobals({ tui, timers, getUrl }) {
  const g = globalThis;

  /* window === globalThis */
  if (!Object.getOwnPropertyDescriptor(g, 'window')) {
    Object.defineProperty(g, 'window', {
      value: g, configurable: true, writable: false,
    });
  }
  g.self = g;

  /* navigator */
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

  /* viewport size (from ncurses) */
  function readSize() {
    try { return tui.size(); } catch (_) { return { rows: 24, cols: 80 }; }
  }
  const sizeDef = { configurable: true, get() { return readSize().cols; } };
  const sizeDefH = { configurable: true, get() { return readSize().rows; } };
  Object.defineProperty(g, 'innerWidth',  sizeDef);
  Object.defineProperty(g, 'innerHeight', sizeDefH);
  Object.defineProperty(g, 'outerWidth',  { configurable: true, get: sizeDef.get });
  Object.defineProperty(g, 'outerHeight', { configurable: true, get: sizeDefH.get });
  Object.defineProperty(g, 'devicePixelRatio', { value: 1, configurable: true });
  Object.defineProperty(g, 'scrollX', { value: 0, configurable: true });
  Object.defineProperty(g, 'scrollY', { value: 0, configurable: true });
  Object.defineProperty(g, 'pageXOffset', { value: 0, configurable: true });
  Object.defineProperty(g, 'pageYOffset', { value: 0, configurable: true });

  /* performance */
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

  /* storage */
  if (!g.localStorage)   g.localStorage   = makeStorage();
  if (!g.sessionStorage) g.sessionStorage = makeStorage();

  /* matchMedia (always "no match") */
  if (!g.matchMedia) {
    g.matchMedia = (q) => ({
      matches: false,
      media: String(q),
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
    });
  }

  /* timers */
  g.setTimeout    = timers.setTimeout;
  g.setInterval   = timers.setInterval;
  g.clearTimeout  = timers.clearTimeout;
  g.clearInterval = timers.clearInterval;

  /* requestAnimationFrame — ~16 ms granularity is fine for a terminal */
  if (!g.requestAnimationFrame) {
    g.requestAnimationFrame = (fn) => {
      return timers.setTimeout(() => {
        try { fn(g.performance.now()); }
        catch (e) { console.log('[rAF] ' + (e && e.message ? e.message : String(e))); }
      }, 16);
    };
    g.cancelAnimationFrame = (id) => timers.clearTimeout(id);
  }

  /* queueMicrotask — QuickJS promises are microtask-driven already */
  if (!g.queueMicrotask) {
    g.queueMicrotask = (fn) => { Promise.resolve().then(fn); };
  }

  /* location — read-only view over the active tab URL */
  if (!g.location) {
    Object.defineProperty(g, 'location', {
      configurable: true,
      get() { return makeLocation(getUrl ? getUrl() : ''); },
      set(_v) { /* TODO: navigate — PR 4+ */ },
    });
  }

  /* history — no-ops that must exist so routers don't crash */
  if (!g.history) {
    g.history = {
      length: 1,
      state: null,
      pushState(_s, _t, _u) {},
      replaceState(_s, _t, _u) {},
      back() {}, forward() {}, go() {},
    };
  }

  /* console aliases React/Webpack print through */
  if (g.console) {
    if (!g.console.warn)  g.console.warn  = g.console.log;
    if (!g.console.info)  g.console.info  = g.console.log;
    if (!g.console.debug) g.console.debug = g.console.log;
    if (!g.console.trace) g.console.trace = g.console.log;
  }
}
