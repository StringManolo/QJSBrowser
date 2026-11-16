/* Browser-shaped globals that page JS (React, Webpack, Vite, polyfills)
 * touch during bootstrap. No DOM yet — that's PR 2. Idempotent: safe to
 * call twice (checks existence before defining). */

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
    if (!g.console.warn)  g.console.warn  = g.console.log;
    if (!g.console.info)  g.console.info  = g.console.log;
    if (!g.console.debug) g.console.debug = g.console.log;
  }
}
