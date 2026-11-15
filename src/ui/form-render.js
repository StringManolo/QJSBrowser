/* Given a form segment (from html-to-text) and its current state (from
 * formState), produce the visual representation { text, width, pair, flags }.
 *
 * The caller is responsible for invalidating any layout cache when state
 * changes — render is pure, layout is what consults this. */

const BASE_WIDTH = 20;   // default text input width when no `size` attr
const MAX_WIDTH  = 60;

export function renderFormElement(seg, el, theme, focused) {
  const P = theme.pairs;
  const pair    = focused ? P.inputFocus : P.input;
  const disPair = P.disabled;
  const flags   = 0;

  if (!el) {
    // Element not registered — render a placeholder
    return { text: `[${seg.kind}:${seg.elementId}]`, width: seg.kind.length + 8, pair, flags };
  }

  if (el.disabled) {
    return { text: renderDisabled(seg, el), width: renderDisabled(seg, el).length, pair: disPair, flags };
  }

  switch (el.kind) {
    case 'checkbox': {
      const t = el.checked ? '[✓]' : '[ ]';
      return { text: t, width: 3, pair, flags };
    }
    case 'radio': {
      const t = el.checked ? '(•)' : '( )';
      return { text: t, width: 3, pair, flags };
    }
    case 'text': {
      const val = el.value || '';
      const ph = el.placeholder || '';
      const size = el.size || BASE_WIDTH;
      let innerWidth = Math.min(MAX_WIDTH, Math.max(size, val.length, ph.length, 6));
      const cursor = focused ? el._cursor : -1;

      let shown = val.length > innerWidth ? val.slice(val.length - innerWidth) : val;
      if (shown.length < innerWidth) shown = shown + ' '.repeat(innerWidth - shown.length);

      let inner;
      if (val.length === 0 && ph.length > 0) {
        inner = ph.slice(0, innerWidth).padEnd(innerWidth);
        const text = '[' + inner + ']';
        const pairPh = focused ? pair : P.inputPlaceholder;
        if (focused && cursor >= 0) {
          const c = Math.min(cursor, innerWidth - 1);
          const before = inner.slice(0, c);
          const after  = inner.slice(c + 1);
          return { text: '[' + before + '▌' + after + ']', width: innerWidth + 2, pair, flags };
        }
        return { text, width: innerWidth + 2, pair: pairPh, flags };
      }

      if (focused && cursor >= 0) {
        const c = Math.min(cursor, innerWidth - 1);
        const before = shown.slice(0, c);
        const after  = shown.slice(c + 1);
        inner = before + '▌' + after;
      } else {
        inner = shown;
      }
      return { text: '[' + inner + ']', width: innerWidth + 2, pair, flags };
    }
    case 'password': {
      const val = el.value || '';
      const size = el.size || BASE_WIDTH;
      const innerWidth = Math.min(MAX_WIDTH, Math.max(size, 6));
      let masked = '•'.repeat(Math.min(val.length, innerWidth));
      if (masked.length < innerWidth) masked += ' '.repeat(innerWidth - masked.length);
      const cursor = focused ? el._cursor : -1;
      if (focused && cursor >= 0) {
        const c = Math.min(cursor, innerWidth - 1);
        masked = masked.slice(0, c) + '▌' + masked.slice(c + 1);
      }
      return { text: '[' + masked + ']', width: innerWidth + 2, pair, flags };
    }
    case 'textarea': {
      const val = el.value || '';
      const w = Math.min(60, el.cols || 40);
      const h = Math.max(2, el.rows || 3);
      const lines = wrapText(val, w);
      const visible = lines.slice(0, h).map(l => l.padEnd(w, ' '));
      while (visible.length < h) visible.push(' '.repeat(w));
      return {
        text: visible.join('\n'),
        width: w + 2,
        height: h + 2,
        pair, flags,
        multiline: true,
      };
    }
    case 'select': {
      const options = el.options || [];
      const sel = options[el.selectedIndex || 0];
      const label = sel ? (sel.label || sel.value || '') : '(select)';
      const inner = label.slice(0, 40);
      return { text: '[' + inner + ' ▼]', width: inner.length + 4, pair, flags };
    }
    case 'submit':
    case 'reset':
    case 'button': {
      const label = el.value || (el.kind === 'submit' ? 'Submit'
                              : el.kind === 'reset' ? 'Reset' : 'Button');
      const inner = ' ' + label + ' ';
      const btnPair = focused ? P.buttonFocus : P.button;
      return { text: '[' + inner + ']', width: inner.length + 2, pair: btnPair, flags };
    }
    default:
      return { text: `[${el.kind}]`, width: el.kind.length + 2, pair, flags };
  }
}

function renderDisabled(seg, el) {
  if (el.kind === 'checkbox') return el.checked ? '[✓]' : '[ ]';
  if (el.kind === 'radio')    return el.checked ? '(•)' : '( )';
  if (el.kind === 'text' || el.kind === 'password') {
    const size = Math.min(MAX_WIDTH, Math.max(el.size || BASE_WIDTH, 6));
    return '[' + ' '.repeat(size) + ']';
  }
  if (el.kind === 'submit' || el.kind === 'reset' || el.kind === 'button') {
    return '[' + (el.value || el.kind) + ']';
  }
  if (el.kind === 'select') return '[disabled ▼]';
  return '[disabled]';
}

function wrapText(val, w) {
  const out = [];
  for (const line of val.split('\n')) {
    if (line.length === 0) { out.push(''); continue; }
    for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w));
  }
  return out.length ? out : [''];
}
