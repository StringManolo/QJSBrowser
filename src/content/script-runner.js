/* Executes a list of <script> entries in document order.
 *
 * - Inline scripts run synchronously.
 * - External scripts are fetched via httpClient.fetchPromise (which
 *   rejects if the tab is aborted mid-navigation).
 * - Each script is wrapped in try/catch: an error in one does not stop
 *   the others (matches browser behavior). Errors are caught INSIDE
 *   runOne, logged there, and NOT re-thrown. The chain continues.
 * - If the tab navigates away (navId changes), the chain quietly stops.
 * - On eval failure of an external script, log status, content-type,
 *   body length and a body preview so we can tell apart "HTML error
 *   page", "chunked markers still present", "real syntax error".
 */

export function runScripts(scripts, ctx) {
  const startNavId = ctx.tab.navId;
  const isStale = () => ctx.tab.navId !== startNavId;

  let chain = Promise.resolve();
  for (const s of scripts) {
    chain = chain.then(() => {
      if (isStale()) return;
      return runOne(s, ctx);
    });
  }
  return chain;
}

/* QuickJS's Error.stack does not include the "Name: message" header that
 * V8 prepends. Reconstruct it so logs are useful. */
function formatScriptError(e) {
  if (!e) return 'Error';
  const name = e.name || 'Error';
  const msg  = e.message || '';
  const stack = e.stack ? String(e.stack) : '';
  if (msg && !stack.startsWith(name + ':'))
    return name + ': ' + msg + (stack ? '\n' + stack : '');
  if (msg) return name + ': ' + msg;
  return stack || String(e);
}

function runOne(script, ctx) {
  const type = (script.type || 'text/javascript').toLowerCase().trim();

  /* Skip non-JS data scripts (<script type="application/json"> etc.). */
  if (type && type !== 'text/javascript' && type !== 'application/javascript' &&
      type !== 'text/ecmascript' && type !== 'application/ecmascript' &&
      type !== 'module') {
    return Promise.resolve();
  }
  if (type === 'module') {
    console.warn('[script] type="module" not supported yet — skipping ' +
                 (script.src || '(inline)'));
    return Promise.resolve();
  }

  if (script.src) {
    return ctx.httpClient.fetchPromise(script.src, {
      tabId: ctx.tab.id,
      navId: ctx.tab.navId,
    }).then(({ resp }) => {
      if (!resp || !resp.body) {
        console.warn('[script] empty body for ' + script.src);
        return;
      }
      try {
        (0, eval)(resp.body);
      } catch (e) {
        const ct = (resp.headers && resp.headers['content-type']) || '(none)';
        const preview = String(resp.body)
          .slice(0, 400)
          .replace(/\r/g, '\\r')
          .replace(/\n/g, '\\n');
        console.error('[script] eval failed for ' + script.src);
        console.error('[script]   status=' + resp.status +
                      ' content-type=' + ct +
                      ' body-length=' + resp.body.length);
        console.error('[script]   error: ' + formatScriptError(e));
        console.error('[script]   body preview: ' + preview);
      }
    }).catch((e) => {
      console.error('[script] fetch failed for ' + script.src + ': ' +
                    formatScriptError(e));
    });
  }

  if (script.inline && script.inline.length > 0) {
    try {
      (0, eval)(script.inline);
    } catch (e) {
      console.error('[script] inline eval failed: ' + formatScriptError(e));
    }
  }
  return Promise.resolve();
}
