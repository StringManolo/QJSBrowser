/* Minimal CSS parser: extracts rules from a stylesheet string.
 * Returns [{ selectors: [str], declarations: {prop: value}, order: int }]
 *
 * Supported: tag, .class, #id, tag.class, comma-separated lists.
 * Ignored: @-rules, pseudo-classes, combinators. */

const SKIP_AT_RULES = new Set([
  'media', 'import', 'font-face', 'keyframes', 'supports', 'charset', 'page',
]);

export function parseStylesheet(css) {
  if (!css) return [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const rules = [];
  let i = 0;
  let order = 0;

  while (i < css.length) {
    // Skip whitespace
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;

    // @-rule → skip whole block
    if (css[i] === '@') {
      const end = css.indexOf('{', i);
      if (end < 0) break;
      const nameMatch = css.slice(i, end).match(/@([\w-]+)/);
      const name = nameMatch ? nameMatch[1].toLowerCase() : '';
      if (SKIP_AT_RULES.has(name)) {
        // find matching close brace (handle nesting naively)
        let depth = 0, j = end;
        while (j < css.length) {
          if (css[j] === '{') depth++;
          else if (css[j] === '}') { depth--; if (depth === 0) { j++; break; } }
          j++;
        }
        i = j;
      } else {
        i = end + 1;
      }
      continue;
    }

    // Selector list up to `{`
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selectorText = css.slice(i, open).trim();
    const close = css.indexOf('}', open);
    if (close < 0) break;
    const declText = css.slice(open + 1, close);

    if (selectorText) {
      const selectors = selectorText.split(',').map(s => s.trim()).filter(Boolean);
      const declarations = parseDeclarations(declText);
      if (Object.keys(declarations).length > 0) {
        rules.push({ selectors, declarations, order: order++ });
      }
    }
    i = close + 1;
  }

  return rules;
}

export function parseDeclarations(text) {
  const out = {};
  for (const raw of text.split(';')) {
    const t = raw.trim();
    if (!t) continue;
    const colon = t.indexOf(':');
    if (colon < 0) continue;
    const prop = t.slice(0, colon).trim().toLowerCase();
    let value = t.slice(colon + 1).trim();
    value = value.replace(/\s*!important\s*$/i, '');
    if (prop && value) out[prop] = value;
  }
  return out;
}

export function parseInlineStyle(styleAttr) {
  return parseDeclarations(styleAttr || '');
}
