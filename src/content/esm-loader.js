/* src/content/esm-loader.js */
import { transpileModule } from './esm-transpiler.js';

function injectStyle(css, url) {
  const doc = globalThis.document;
  if (!doc) return;
  const parent = doc.head || doc.body;
  if (!parent) return;
  const style = doc.createElement('style');
  style.setAttribute('data-module', url);
  style.textContent = css;
  parent.appendChild(style);
}

export function createModuleLoader({ fetchSource, resolveSpecifier }) {
  const modules  = new Map();
  const inflight = new Map();

  function isCSS(url) { return /\.css(\?|#|$)/i.test(url); }

  function ensureLoaded(url) {
    if (modules.has(url)) return Promise.resolve(modules.get(url));
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      const order = [], visited = new Set();
      await fetchGraph(url, visited, order);
      for (const u of order) {
        const m = modules.get(u);
        if (!m || m.executed) continue;
        executeModule(u);
      }
      return modules.get(url);
    })();
    inflight.set(url, p);
    p.then(() => inflight.delete(url), () => inflight.delete(url));
    return p;
  }

  async function fetchGraph(url, visited, order, preFetchedSource) {
  if (visited.has(url)) return;
  visited.add(url);

  if (isCSS(url)) {
    let source = preFetchedSource;
    if (source === undefined) source = await fetchSource(url);
    try { console.log('[esm] css ' + url); } catch (_) {}
    injectStyle(source, url);
    modules.set(url, { code: '', imports: [], exports: {}, executed: true });
    return;
  }

  const source = preFetchedSource !== undefined
               ? preFetchedSource
               : await fetchSource(url);
  try { console.log('[esm] fetch ' + url + ' (' + source.length + ' bytes)'); } catch (_) {}

  const { code, imports } = transpileModule(source, url, resolveSpecifier);
  modules.set(url, { code, imports, exports: {}, executed: false });
  try {
    console.log('[esm] transpiled ' + url + ' -> deps=[' + imports.join(', ') + ']');
  } catch (_) {}

  for (const dep of imports) {
    if (modules.has(dep) || visited.has(dep)) continue;
    await fetchGraph(dep, visited, order);
  }
  order.push(url);
}

function executeModule(url) {
  const m = modules.get(url);
  if (!m || m.executed) return m ? m.exports : {};
  m.executed = true;

  const modulesArg = Object.create(null);
  for (const dep of m.imports) {
    const depMod = modules.get(dep);
    modulesArg[dep] = depMod ? depMod.exports : {};
  }

  const moduleImport = (spec) => {
    let depUrl;
    try {
      depUrl = resolveSpecifier(spec, url);
    } catch (e) {
      try { console.error('[esm] RESOLVE FAILED "' + spec + '" from ' + url + ': ' + e.message); } catch (_) {}
      throw e;
    }
    try { console.log('[esm] dynamic import "' + spec + '" from ' + url + ' -> ' + depUrl); } catch (_) {}
    return ensureLoaded(depUrl).then(mm => mm.exports)
      .catch((e) => {
        try { console.error('[esm] import failed ' + depUrl + ': ' + (e && e.message || e)); } catch (_) {}
        throw e;
      });
  };
  const moduleRequire = () => {};

  const fn = new Function(
    '__modules__', '__exports__', '__import', '__require',
    "'use strict';" + m.code
  );
  try {
    fn(modulesArg, m.exports, moduleImport, moduleRequire);
    try { console.log('[esm] executed ' + url); } catch (_) {}
  } catch (e) {
    try { console.error('[esm] exec failed ' + url + ': ' + (e && e.message || e)); } catch (_) {}
    throw e;
  }
  return m.exports;
}

  function load(url) { return ensureLoaded(url).then(m => m.exports); }

  function loadInline(url, source) {
    if (modules.has(url)) return Promise.resolve(modules.get(url).exports);
    if (inflight.has(url)) return inflight.get(url).then(m => m.exports);
    const p = (async () => {
      const order = [], visited = new Set();
      await fetchGraph(url, visited, order, source);
      for (const u of order) {
        const m = modules.get(u);
        if (!m || m.executed) continue;
        executeModule(u);
      }
      return modules.get(url);
    })();
    inflight.set(url, p);
    p.then(() => inflight.delete(url), () => inflight.delete(url));
    return p.then(m => m.exports);
  }

  return { load, loadInline };
}
