/* Developer console overlay.
 *
 * Evaluates in the global scope via indirect eval. Captures console.log/
 * warn/error from anywhere (browser internals, user code) into the output
 * panel. Drains globalThis._lastPumpError (set by C's js_pump_jobs) into
 * the panel as errors after every pump, so unhandled rejections surface
 * here instead of corrupting ncurses via stderr.
 *
 * Multiline input is fully visible (last up-to-4 lines shown).
 *
 * Keys:
 *   Tab         complete identifier (globals, dotted paths)
 *   F12 / Esc   toggle / close (Esc clears non-empty input first)
 *   Enter       evaluate (if balanced) or newline
 *   Up / Down   history
 *   Ctrl+L      clear output
 *   Ctrl+U      clear input
 *   PgUp/PgDn   scroll output
 *   _           (after a result) references the last value
 */

const MAX_OUTPUT_ITEMS = 500;
const MAX_OUTPUT_LINES = 2000;
const MAX_INPUT_ROWS   = 4;
const MAX_COMPLETION_HINTS = 50;

export function createConsole({ tui, theme }) {
  let visible    = false;
  let input      = '';
  let cursor     = 0;
  let output     = [];       /* [{ kind: 'input'|'log'|'result'|'error', text }] */
  let history    = [];
  let historyIdx = -1;
  let savedInput = '';
  let scrollY    = 0;

  const P = theme.pairs;
  const pairBg     = P.page    != null ? P.page    : 1;
  const pairHeader = pairBg;
  const pairPrompt = P.link    != null ? P.link    : pairBg;
  const pairResult = P.page    != null ? P.page    : 1;
  const pairError  = P.error   != null ? P.error
                   : P.warning != null ? P.warning : pairBg;

  /* --- value formatting ------------------------------------------------- */

  function stringifyWith(seen, v) {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    if (typeof v === 'function')
      return '[Function: ' + (v.name || 'anonymous') + ']';
    return v;
  }

  function formatValue(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (v === globalThis) return '[global]';
    const t = typeof v;
    if (t === 'string') {
      const s = v.length > 500 ? v.slice(0, 500) + '…' : v;
      return JSON.stringify(s);
    }
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return String(v);
    if (t === 'function') return '[Function: ' + (v.name || 'anonymous') + ']';
    if (Array.isArray(v) && v.length > 100) {
      const head = v.slice(0, 100).map(formatValue).join(', ');
      return '[' + head + ', … (' + v.length + ' items)]';
    }
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, val) => stringifyWith(seen, val), 2);
    } catch (_) {
      try { return String(v); } catch (__) { return '[object]'; }
    }
  }

  function formatArg(a) {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    const t = typeof a;
    if (t === 'string') return a;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(a);
    if (t === 'function') return '[Function: ' + (a.name || 'anonymous') + ']';
    if (t === 'symbol') return String(a);
    try {
      const seen = new WeakSet();
      return JSON.stringify(a, (k, v) => stringifyWith(seen, v), 2);
    } catch (_) {
      try { return String(a); } catch (__) { return '[object]'; }
    }
  }

  function formatError(e) {
    if (!e) return 'Error';
    if (e.stack) return String(e.stack).split('\n').slice(0, 8).join('\n');
    if (e.message) return (e.name || 'Error') + ': ' + e.message;
    return String(e);
  }

  /* --- enter: expression vs. continuation ------------------------------ */

  function looksBalanced(code) {
    let depth = 0, inStr = null, inLine = false, inBlock = false;
    for (let i = 0; i < code.length; i++) {
      const c = code[i], n = code[i + 1];
      if (inLine)  { if (c === '\n') inLine = false; continue; }
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
      if (inStr)   { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
      if (c === '/' && n === '/') { inLine  = true; i++; continue; }
      if (c === '/' && n === '*') { inBlock = true; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{' || c === '(' || c === '[') depth++;
      if (c === '}' || c === ')' || c === ']') depth--;
    }
    return depth === 0 && !inStr && !inLine && !inBlock;
  }

  /* --- output ---------------------------------------------------------- */

  function pushOutput(item) {
    output.push(item);
    while (output.length > MAX_OUTPUT_ITEMS) output.shift();
    let lines = 0;
    for (const o of output) lines += String(o.text).split('\n').length;
    while (lines > MAX_OUTPUT_LINES && output.length > 1) {
      lines -= String(output.shift().text).split('\n').length;
    }
  }

  function appendOutput(kind, args) {
    const text = Array.isArray(args) ? args.map(formatArg).join(' ') : String(args);
    pushOutput({ kind: kind || 'log', text: '  ' + text });
    scrollY = 0;
  }

  function clearOutput() {
    output  = [];
    scrollY = 0;
  }

  /* --- QuickJS microtask pump ----------------------------------------- */

  /* Drain C-side accumulated pump errors into the panel. Never trust
   * globalThis._lastPumpError to be a string — the C side may have left
   * it undefined/null, or user code may have overwritten it. */
  function drainPumpErrors() {
    const err = globalThis._lastPumpError;
    if (!err) return;
    globalThis._lastPumpError = '';
    pushOutput({ kind: 'error', text: String(err) });
    scrollY = 0;
  }

  function pumpJobsAndDrain() {
    if (typeof pumpJobs === 'function') {
      try { pumpJobs(200); } catch (_) {}
    }
    drainPumpErrors();
  }

  /* --- evaluation ------------------------------------------------------ */

  function run() {
    const code = input.trim();
    if (!code) return;

    pushOutput({ kind: 'input', text: '> ' + code });
    history.push(code);
    if (history.length > 200) history.shift();
    historyIdx = -1;
    savedInput = '';

    let result, error;
    try { result = (0, eval)(code); } catch (e) { error = e; }

    /* Drain microtasks the eval may have scheduled (e.g. Promise.resolve()
     * .then(console.log)). Errors from C-side pumps surface in the panel. */
    pumpJobsAndDrain();

    if (error) {
      pushOutput({ kind: 'error', text: formatError(error) });
    } else if (result !== undefined) {
      globalThis._ = result;

      if (result && typeof result.then === 'function') {
        pushOutput({ kind: 'result', text: 'Promise { <pending> }' });
        const tag = output.length - 1;
        result.then(
          v => { if (output[tag]) output[tag] = { kind: 'result', text: '→ ' + formatValue(v) }; },
          e => { if (output[tag]) output[tag] = { kind: 'error',  text: 'Promise rejected: ' + formatValue(e) }; }
        );
        pumpJobsAndDrain();
      } else {
        pushOutput({ kind: 'result', text: '→ ' + formatValue(result) });
      }
    }

    input   = '';
    cursor  = 0;
    scrollY = 0;
  }

  /* --- Tab completion -------------------------------------------------- */

  /* Completes the identifier immediately before the cursor. Supports
   * `ident` (globals) and `path.to.ident` (properties). Deliberately does
   * NOT track user-declared variables — that requires real parsing and is
   * where every REPL completion gets buggy. */
  function complete() {
    try {
      const upToCursor = input.slice(0, cursor);
      const m = upToCursor.match(/([\w$.]*)$/);
      if (!m || !m[0]) return;
      const token = m[0];

      let baseObj, lastPart;
      const lastDot = token.lastIndexOf('.');
      if (lastDot < 0) {
        baseObj  = globalThis;
        lastPart = token;
      } else {
        const basePath = token.slice(0, lastDot);
        lastPart = token.slice(lastDot + 1);
        try { baseObj = (0, eval)(basePath); }
        catch (_) { return; }
      }
      if (baseObj === null || baseObj === undefined) return;

      /* Collect from own properties + up to 2 prototype levels.
       * Stops at Object.prototype to avoid toString/hasOwnProperty noise. */
      const cands = [];
      const seen  = new Set();
      let   obj   = Object(baseObj);
      let   depth = 0;
      while (obj && obj !== Object.prototype && depth < 3) {
        let keys;
        try { keys = Object.getOwnPropertyNames(obj); }
        catch (_) { break; }
        for (const k of keys) {
          if (k.startsWith(lastPart) && !seen.has(k)) {
            seen.add(k);
            cands.push(k);
          }
        }
        try { obj = Object.getPrototypeOf(obj); } catch (_) { break; }
        depth++;
      }
      if (cands.length === 0) return;
      cands.sort();

      let insertText;
      if (cands.length === 1) {
        insertText = cands[0];
      } else {
        let cp = cands[0];
        for (let i = 1; i < cands.length; i++) {
          while (cp.length > 0 && !cands[i].startsWith(cp)) cp = cp.slice(0, -1);
          if (cp.length === 0) break;
        }
        if (cp.length > lastPart.length) {
          insertText = cp;
        } else {
          /* No extra chars to insert — just list the candidates. */
          const shown = cands.length > MAX_COMPLETION_HINTS
            ? cands.slice(0, MAX_COMPLETION_HINTS).join('   ') +
              '   … (' + (cands.length - MAX_COMPLETION_HINTS) + ' more)'
            : cands.join('   ');
          appendOutput('log', [shown]);
          return;
        }
      }

      const before = input.slice(0, cursor - lastPart.length) + insertText;
      input  = before + input.slice(cursor);
      cursor = before.length;
    } catch (_) { /* completion is best-effort, never throw */ }
  }

  /* --- public API ------------------------------------------------------ */

  function isVisible() { return visible; }
  function toggle() {
    visible = !visible;
    tui.setCursor(visible ? 1 : 0);
  }
  function close() {
    if (!visible) return;
    visible = false;
    tui.setCursor(0);
  }

  /* --- key handling ---------------------------------------------------- */

  function handleKey(ch) {
    if (ch === tui.KEY_F12 || ch === 27 /* ESC */) {
      if (ch === 27 && input.length > 0) { input = ''; cursor = 0; return; }
      close();
      return;
    }
    if (ch === 12 /* Ctrl+L */) { clearOutput(); return; }
    if (ch === 21 /* Ctrl+U */) { input = ''; cursor = 0; return; }
    if (ch === 3  /* Ctrl+C */) { input = ''; cursor = 0; return; }
    if (ch === 9  /* Tab */)    { complete(); return; }

    if (ch === tui.KEY_ENTER || ch === 10 || ch === 13) {
      if (looksBalanced(input)) run();
      else {
        input = input.slice(0, cursor) + '\n' + input.slice(cursor);
        cursor++;
      }
      return;
    }
    if (ch === tui.KEY_BACKSPACE || ch === 8 || ch === 127) {
      if (cursor > 0) {
        input = input.slice(0, cursor - 1) + input.slice(cursor);
        cursor--;
      }
      return;
    }
    if (ch === tui.KEY_DC) {
      if (cursor < input.length)
        input = input.slice(0, cursor) + input.slice(cursor + 1);
      return;
    }
    if (ch === tui.KEY_LEFT)  { if (cursor > 0) cursor--; return; }
    if (ch === tui.KEY_RIGHT) { if (cursor < input.length) cursor++; return; }
    if (ch === tui.KEY_HOME)  { cursor = 0; return; }
    if (ch === tui.KEY_END)   { cursor = input.length; return; }

    if (ch === tui.KEY_UP) {
      if (history.length === 0) return;
      if (historyIdx === -1) { savedInput = input; historyIdx = history.length - 1; }
      else if (historyIdx > 0) historyIdx--;
      input  = history[historyIdx];
      cursor = input.length;
      return;
    }
    if (ch === tui.KEY_DOWN) {
      if (historyIdx === -1) return;
      if (historyIdx < history.length - 1) {
        historyIdx++;
        input = history[historyIdx];
      } else {
        historyIdx = -1;
        input = savedInput;
      }
      cursor = input.length;
      return;
    }
    if (ch === tui.KEY_PPAGE) { scrollY += 10; return; }
    if (ch === tui.KEY_NPAGE) { scrollY = Math.max(0, scrollY - 10); return; }
    if (ch === tui.KEY_RESIZE) return;

    if (ch >= 32 && ch < 127) {
      input = input.slice(0, cursor) + String.fromCharCode(ch) + input.slice(cursor);
      cursor++;
    }
  }

  /* --- render ---------------------------------------------------------- */

  function render(x, y, w, h) {
    if (!visible) return;

    tui.fillPair(y, x, h, w, pairBg);

    const header = ' CONSOLE   Tab: complete   F12: close   Ctrl+L: clear   ↑/↓: history   _: last ';
    tui.printPair(y, x, header.slice(0, w).padEnd(w, ' '),
                  pairHeader, tui.A_BOLD | tui.A_REVERSE);

    const inputLines = input.split('\n');
    const numLines   = inputLines.length;
    const inputRows  = Math.max(1, Math.min(numLines, MAX_INPUT_ROWS,
                                            Math.max(1, Math.floor(h / 3))));
    const inputTop   = y + h - inputRows;
    const firstShown = numLines - inputRows;

    const outTop    = 1;
    const outHeight = Math.max(1, inputTop - (y + 1));

    /* Clip to w-1: text printed at x+1; len==w would end at x+w,
     * one column past the last valid index → ncurses wrap → stale cells. */
    const avail = Math.max(1, w - 1);

    const lines = [];
    for (const item of output) {
      const parts = String(item.text).split('\n');
      for (const s of parts) {
        if (s.length === 0) { lines.push({ text: '', kind: item.kind }); continue; }
        for (let i = 0; i < s.length; i += avail) {
          lines.push({ text: s.slice(i, i + avail), kind: item.kind });
        }
      }
    }

    const total     = lines.length;
    const maxScroll = Math.max(0, total - outHeight);
    if (scrollY > maxScroll) scrollY = maxScroll;
    const start = Math.max(0, total - outHeight - scrollY);

    for (let i = 0; i < outHeight; i++) {
      const row = y + outTop + i;
      const idx = start + i;
      const pair = idx < total
        ? (lines[idx].kind === 'error' ? pairError
         : lines[idx].kind === 'input' ? pairPrompt
         : pairResult)
        : pairBg;
      tui.fillPair(row, x, 1, w, pairBg);
      if (idx < total)
        tui.printPair(row, x + 1, lines[idx].text, pair, 0);
    }

    for (let i = 0; i < inputRows; i++) {
      const lineIdx  = firstShown + i;
      const prefix   = lineIdx === 0 ? '> ' : '… ';
      const lineText = inputLines[lineIdx] || '';
      tui.fillPair(inputTop + i, x, 1, w, pairBg);
      tui.printPair(inputTop + i, x, (prefix + lineText).slice(0, w), pairPrompt, 0);
    }

    const lineStarts = [0];
    for (let i = 0; i < input.length; i++) if (input[i] === '\n') lineStarts.push(i + 1);
    let cursorLine = 0;
    for (let i = 0; i < lineStarts.length; i++) if (cursor >= lineStarts[i]) cursorLine = i;
    const colInLine = cursor - lineStarts[cursorLine];

    if (cursorLine >= firstShown) {
      const rowInView = cursorLine - firstShown;
      const cx = Math.min(w - 1, 2 + colInLine);
      tui.move(inputTop + rowInView, x + cx);
    } else {
      tui.move(inputTop, x + 2);
    }
  }

  return {
    isVisible, toggle, close,
    handleKey, render,
    appendOutput, clearOutput,
  };
}
