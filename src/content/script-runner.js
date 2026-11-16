import { createModuleLoader } from './esm-loader.js';
import { resolveUrl } from 'src/base/url.js';

export function runScripts(scripts, ctx) {
  const startNavId = ctx.tab.navId;
  const isStale = () => ctx.tab.navId !== startNavId;

  const loader = createModuleLoader({
    fetchSource: (url) => fetchScriptSource(url, ctx),
    resolveSpecifier: resolveModuleSpecifier,
  });

  let chain = Promise.resolve();
  for (const s of scripts) {
    chain = chain.then(() => {
      if (isStale()) return;
      return runOne(s, ctx, loader);
    });
  }
  return chain;
}

function resolveModuleSpecifier(spec, baseUrl) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return spec;
  if (spec.startsWith('//')) return 'http:' + spec;
  if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')) {
    return resolveUrl(baseUrl, spec);
  }
  if (spec.startsWith('#')) {
    const hash = baseUrl.indexOf('#');
    return (hash >= 0 ? baseUrl.slice(0, hash) : baseUrl) + spec;
  }
  /* Lenient: some bundles strip the "./" from dynamic imports, leaving
   * a bare filename. If it looks like a file (has a known extension),
   * resolve it against the parent anyway. Better than throwing, because
   * the alternative is QuickJS falling through to its native loader,
   * which reads from disk and fails. */
  if (/\.(m?js|ts|json|css|wasm)(\?|#|$)/i.test(spec)) {
    return resolveUrl(baseUrl, './' + spec);
  }
  throw new Error('bare import specifier "' + spec + '" is not supported');
}

function fetchScriptSource(url, ctx) {
  return ctx.httpClient.fetchPromise(url, {
    tabId: ctx.tab.id,
    navId: ctx.tab.navId,
  }).then(({ resp }) => {
    if (!resp) throw new Error('no response for ' + url);
    if (resp.status >= 400) throw new Error('HTTP ' + resp.status + ' for ' + url);
    return resp.body || '';
  });
}

function dbgErr(e) {
  if (e === null || e === undefined) return String(e);
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    try {
      if (e.name || e.message) {
        return (e.name || 'Error') + ': ' + (e.message || '') +
               (e.stack ? '\n' + e.stack : '');
      }
      const s = JSON.stringify(e);
      if (s && s !== '{}') return s;
      const keys = Object.keys(e);
      if (keys.length) return keys.map(k => k + '=' + String(e[k])).join(', ');
      return Object.prototype.toString.call(e);
    } catch (_) { return String(e); }
  }
  return String(e);
}

function runOne(script, ctx, loader) {
  const type = (script.type || 'text/javascript').toLowerCase().trim();

  if (script.element && typeof script.element.hasAttribute === 'function' &&
      script.element.hasAttribute('nomodule')) {
    return Promise.resolve();
  }

  if (type && type !== 'text/javascript' && type !== 'application/javascript' &&
      type !== 'text/ecmascript' && type !== 'application/ecmascript' &&
      type !== 'module') {
    return Promise.resolve();
  }

  if (type === 'module') return runModule(script, ctx, loader);

  if (script.src) {
    return fetchScriptSource(script.src, ctx).then((body) => {
      try { (0, eval)(body); }
      catch (e) {
        console.error('[script] eval failed for ' + script.src + ': ' + dbgErr(e));
      }
    }).catch((e) => {
      console.error('[script] fetch failed for ' + script.src + ': ' + dbgErr(e));
    });
  }

  if (script.inline && script.inline.length > 0) {
    try { (0, eval)(script.inline); }
    catch (e) {
      console.error('[script] inline eval failed: ' + dbgErr(e));
    }
  }
  return Promise.resolve();
}

let inlineModuleCounter = 0;

function runModule(script, ctx, loader) {
  if (script.src) {
    return loader.load(script.src).catch((e) => {
      console.error('[module] ' + script.src + ' failed: ' + dbgErr(e));
    });
  }
  if (script.inline && script.inline.length > 0) {
    const base = ctx.url.split('#')[0];
    const url = base + '#inline-module-' + (++inlineModuleCounter);
    return loader.loadInline(url, script.inline).catch((e) => {
      console.error('[module] inline failed: ' + dbgErr(e));
    });
  }
  return Promise.resolve();
}
