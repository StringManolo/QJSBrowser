/* DOM → segments. See header of previous versions for full context.
 *
 * Fixes layered in this version:
 *
 * 1. Whitespace-only text nodes with newlines are skipped. Pretty-printed
 *    HTML inserts '\n    ' between tags. Browsers collapse those to
 *    nothing between blocks. Our naive replace(/[ \t]+/, ' ') did not
 *    touch '\n', so each became a line break — the ~20 blank lines
 *    above the navbar on stringmanolo.qzz.io.
 *
 * 2. position:fixed subtrees skipped entirely.
 *
 * 3. display:flex/grid on the parent suppresses block-break for its
 *    direct children (so e.g. the theme toggle stays on the nav line).
 *
 * 4. Horizontal rules only for EXPLICIT border-top / border-bottom.
 *    The `border` shorthand is a box border (buttons, inputs, cards)
 *    and must NOT emit an HR — before this fix, every bordered box
 *    emitted TWO bars (one on enter, one on exit), turning Google's
 *    consent page into a wall of ─────.
 *
 * 5. HR width comes from opts.width (the page column width). On resize,
 *    the controller re-serializes so bars match the new width.
 *
 * 6. Duplicate HRs are collapsed: if between the previous bar and the
 *    current exit there's only whitespace, skip. Nested bordered divs
 *    or sibling empty bordered divs produce one bar, not N.
 *
 * 7. ANSI-color blacklist: dark CSS colors replaced by theme page color
 *    so #333 text on black terminal is readable; blue links survive.
 */

import { resolveUrl } from 'src/base/url.js';
import { parseStylesheet, parseInlineStyle } from 'src/css/parser.js';
import { matches, specificity } from 'src/css/matcher.js';
import { parseCssColor, snapToAnsi } from 'src/css/color.js';
import { TAG_DEFAULTS } from 'src/css/defaults.js';
import { decodeHtmlEntities } from 'src/content/html-entities.js';

const BLOCK_TAGS = ['p','div','h1','h2','h3','h4','h5','h6',
                    'blockquote','pre','ul','ol','table','form',
                    'article','section','header','footer','main',
                    'nav','aside','figure','figcaption','details',
                    'summary','fieldset','address'];
const INLINE_BG_TAGS = new Set(['code','kbd','samp','mark','pre']);
const TEXT_INPUT_TYPES = new Set(['text','email','tel','url','number','search','password']);
const CLICKABLE_KINDS = new Set(['submit', 'reset', 'button']);
const SKIP_SUBTREE_TAGS = new Set(['style','script','title','noscript','template']);
const REACT_CLICK_MAX_DEPTH = 6;
const FLEX_GRID_DISPLAYS = new Set(['flex','inline-flex','grid','inline-grid']);
const MIN_HR_WIDTH = 20;

function parseDim(v) {
  if (!v) return 0;
  if (!/^\d+$/.test(String(v).trim())) return 0;
  const n = parseInt(v, 10);
  return (n > 0 && n <= 4096) ? n : 0;
}

function fontSizeLevel(fs) {
  if (!fs) return 0;
  const m = String(fs).match(/^(\d+(?:\.\d+)?)\s*(px|pt|em|rem)?$/i);
  if (!m) return 0;
  let px = parseFloat(m[1]);
  if (m[2] === 'em' || m[2] === 'rem') px *= 16;
  else if (m[2] === 'pt') px *= 1.333;
  if (px >= 32) return 1; if (px >= 24) return 2;
  if (px >= 20) return 3; if (px >= 18) return 4;
  if (px >= 16) return 5; return 6;
}

function svgSize(node) {
  const w = parseFloat(node.getAttribute('width'));
  const h = parseFloat(node.getAttribute('height'));
  if (isFinite(w) && isFinite(h) && w > 0 && h > 0)
    return { w: Math.round(w), h: Math.round(h) };
  const vb = node.getAttribute('viewBox');
  if (vb) {
    const parts = String(vb).trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length === 4) {
      const wv = parseFloat(parts[2]);
      const hv = parseFloat(parts[3]);
      if (isFinite(wv) && isFinite(hv) && wv > 0 && hv > 0)
        return { w: Math.round(wv), h: Math.round(hv) };
    }
  }
  return null;
}

function isInvisibleOnBlack(idx) {
  if (idx < 0) return false;
  if (idx === 0 || idx === 8) return true;
  if (idx >= 232 && idx <= 244) return true;
  return false;
}

/* Explicit border-top / border-bottom ONLY. The `border` shorthand is a
 * box (button, input, card) — not a separator. Before dropping the
 * fallback, every bordered button emitted two bars (one on enter for
 * border-top, one on exit for border-bottom) — that was the wall of
 * ───── on Google's consent page. */
function hasVisibleBorder(decls, side) {
  const val = decls['border-' + side];
  if (!val) return false;
  const s = String(val).toLowerCase().trim();
  if (!s || s === 'none' || s === '0') return false;
  if (s.startsWith('none') || s.startsWith('0 ') || s === '0px') return false;
  return true;
}

function buildClickableMap(root) {
  const map = new WeakMap();
  function visit(n) {
    if (!n || n.nodeType !== 1) return;
    try {
      const keys = Object.keys(n);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.length > 13 && k.charCodeAt(0) === 95 && k.startsWith('__reactProps$')) {
          const p = n[k];
          if (p && typeof p.onClick === 'function') { map.set(n, true); break; }
        }
      }
    } catch (_) {}
    if (n.childNodes) for (let i = 0; i < n.childNodes.length; i++) visit(n.childNodes[i]);
  }
  visit(root);
  return map;
}

export function domToText(root, baseUrl, theme, formState, cssTexts, nodeMap, opts) {
  opts = opts || {};
  const pageWidth = Math.max(MIN_HR_WIDTH, opts.width || 40);

  const rules = [];
  for (const css of cssTexts || []) for (const rule of parseStylesheet(css)) rules.push(rule);

  const segments = [];
  const links = [];
  const images = [];
  const _stack = [];
  let linkN = 0;

  const clickable = buildClickableMap(root);

  function nearestClickable(node) {
    let cur = node, d = 0;
    while (cur && d < REACT_CLICK_MAX_DEPTH) {
      if (clickable.has(cur)) return cur;
      cur = cur.parentNode; d++;
    }
    return null;
  }

  function registerSyntheticLink(node) {
    if (!node) return null;
    if (!nearestClickable(node)) return null;
    linkN++;
    links.push({ n: linkN, href: null, node, text: '' });
    return linkN;
  }

  function computeDecls() {
    const decls = {};
    for (const e of _stack) {
      const d = TAG_DEFAULTS[e.tag];
      if (d) Object.assign(decls, d);
    }
    const applicable = [];
    for (const rule of rules) {
      for (const sel of rule.selectors) {
        for (let k = _stack.length - 1; k >= 0; k--) {
          if (matches(sel, _stack[k])) {
            applicable.push({ spec: specificity(sel), order: rule.order, declarations: rule.declarations });
            break;
          }
        }
      }
    }
    applicable.sort((a, b) => a.spec !== b.spec ? a.spec - b.spec : a.order - b.order);
    for (const app of applicable) Object.assign(decls, app.declarations);
    for (const e of _stack) if (e.inlineStyle) Object.assign(decls, e.inlineStyle);
    return decls;
  }

  function makeEntry(node) {
    const tag = node.localName;
    const entry = {
      tag,
      id: node.getAttribute('id') || null,
      classes: new Set((node.getAttribute('class') || '').split(/\s+/).filter(Boolean)),
      inlineStyle: node.getAttribute('style')
        ? parseInlineStyle(node.getAttribute('style')) : null,
      _el: node,
    };

    if (tag === 'a') {
      const hrefAttr = node.getAttribute('href');
      if (hrefAttr) {
        const href = resolveUrl(baseUrl, decodeHtmlEntities(hrefAttr));
        if (/^https?:\/\//i.test(href)) {
          linkN++;
          links.push({ n: linkN, href, text: '' });
          entry.href = href;
          entry.n = linkN;
          entry.prefixEmitted = false;
          entry.accumulated = '';
        }
      }
    }

    if (tag === 'form') {
      const action = node.getAttribute('action')
        ? resolveUrl(baseUrl, decodeHtmlEntities(node.getAttribute('action')))
        : baseUrl;
      const method = (node.getAttribute('method') || 'GET').toUpperCase();
      entry.formId = formState ? formState.newForm(action, method) : null;
    }

    if (tag === 'ol') entry.count = 0;

    if (tag === 'button' || tag === 'select') {
      entry.classes = new Set();
      entry.inlineStyle = null;
    }

    return entry;
  }

  function currentStyle() {
    const decls = computeDecls();

    const fg = parseCssColor(decls['color']);
    let fgAnsi = snapToAnsi(fg, -1);
    if (isInvisibleOnBlack(fgAnsi)) fgAnsi = -1;

    const innermost = _stack[_stack.length - 1];
    const isInlineBg = innermost && INLINE_BG_TAGS.has(innermost.tag);
    let bgAnsi = isInlineBg
      ? snapToAnsi(parseCssColor(decls['background-color']), -1) : -1;
    if (isInvisibleOnBlack(bgAnsi)) bgAnsi = -1;

    const bold = decls['font-weight'] === 'bold' ||
                 (parseInt(decls['font-weight'], 10) >= 600);
    const italic = (decls['font-style'] || '').toLowerCase() === 'italic';
    const underline = (decls['text-decoration'] || '').toLowerCase().includes('underline') || italic;
    const pre = _stack.some(e => e.tag === 'pre');
    const indent = _stack.some(e => e.tag === 'blockquote') ? 2 : 0;
    const hidden = (decls['display'] || '') === 'none' ||
                   (decls['visibility'] || '') === 'hidden';

    let pairOverride = null;
    if (!fg && decls['font-size']) {
      const lvl = fontSizeLevel(decls['font-size']);
      if (lvl >= 1 && lvl <= 3) pairOverride = theme.pairs['heading' + lvl];
      else if (lvl === 4) pairOverride = theme.pairs.heading4;
    }

    return {
      fgAnsi, bgAnsi, bold, underline, indent, pre, hidden, pairOverride,
      borderTop: hasVisibleBorder(decls, 'top'),
      borderBottom: hasVisibleBorder(decls, 'bottom'),
    };
  }

  function emitBlockBreak(tag) {
    if (segments.length === 0) return;
    const last = segments[segments.length - 1];
    if (last.kind === 'bullet') return;
    if (last.type === 'form' && tag === 'form') return;
    const lastText = last.text || '';
    if (lastText.endsWith('\n\n')) return;
    if (lastText.endsWith('\n')) segments.push({ text: '\n', linkN: null });
    else segments.push({ text: '\n\n', linkN: null });
  }

  function emitHorizontalRule() {
    /* Dedupe: walk back through whitespace-only segments. If we hit
     * another bar before hitting real content, skip. Collapses:
     *   - nested bordered divs (child + parent both emit on exit)
     *   - sibling empty bordered divs (two separators, one gap)
     *   - bar followed by a block-break followed by another bar
     * into a single visible line. */
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (s._isHr) return;
      const t = s.text || '';
      if (t && /[^\s]/.test(t)) break;
    }

    while (segments.length > 0) {
      const last = segments[segments.length - 1];
      if (last.text && last.text.endsWith('\n\n') && !last.linkN) {
        const trimmed = last.text.replace(/\n+$/, '\n');
        if (trimmed === '\n') { segments.pop(); continue; }
        last.text = trimmed;
      }
      break;
    }
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      if (!(last.text || '').endsWith('\n')) segments.push({ text: '\n', linkN: null });
    }
    segments.push({
      text: '─'.repeat(pageWidth) + '\n',
      linkN: null,
      pair: theme.pairs.separator,
      _isHr: true,
    });
  }

  function topLink() {
    for (let k = _stack.length - 1; k >= 0; k--) if (_stack[k].tag === 'a') return _stack[k];
    return null;
  }

  function currentFormId() {
    for (let k = _stack.length - 1; k >= 0; k--) {
      if (_stack[k].tag === 'form') return _stack[k].formId;
    }
    return null;
  }

  function emitText(raw) {
    if (!raw) return;
    const s = currentStyle();
    if (s.hidden) return;

    if (!s.pre && /^\s*\n\s*$/.test(raw)) return;

    let text = s.pre ? decodeHtmlEntities(raw)
                     : decodeHtmlEntities(raw.replace(/\s+/g, ' '));
    if (s.pre && text === '') return;

    const a = topLink();
    let linkNForSeg = null;
    if (a && a.href) {
      linkNForSeg = a.n;
      a.accumulated += text;
      if (!a.prefixEmitted) { text = `[${a.n}]` + text; a.prefixEmitted = true; }
    }

    if (s.indent > 0) {
      const pad = ' '.repeat(s.indent);
      if (segments.length === 0) text = pad + text;
      else {
        const last = segments[segments.length - 1];
        if (!last.text) segments.push({ text: '\n', linkN: null });
        else if (last.text.endsWith('\n')) text = pad + text;
      }
      text = text.replace(/\n/g, '\n' + pad);
    }

    const innermost = _stack[_stack.length - 1];
    const node = innermost ? innermost._el : null;
    if (linkNForSeg === null && node) {
      const synthetic = registerSyntheticLink(node);
      if (synthetic !== null) {
        linkNForSeg = synthetic;
        links[synthetic - 1].text = text;
      }
    }

    let pairId;
    if (s.fgAnsi >= 0 || s.bgAnsi >= 0) pairId = theme.lookupPair(s.fgAnsi, s.bgAnsi);
    else if (s.pairOverride) pairId = theme.pairs.pairOverride;
    else if (linkNForSeg !== null) pairId = theme.pairs.link;
    else pairId = theme.pairs.page;

    segments.push({
      text,
      linkN: linkNForSeg,
      pair: pairId,
      bold: s.bold,
      underline: s.underline,
    });
  }

  function pushFormSegment(kind, info, node) {
    if (!formState) return;
    info.formId = currentFormId();
    const id = formState.addElement(info);
    if (nodeMap && node) nodeMap.set(id, node);

    if (CLICKABLE_KINDS.has(kind) && segments.length > 0) {
      const last = segments[segments.length - 1];
      if (last.type === 'form') segments.push({ text: ' ', linkN: null });
      else if (last.text && last.text.length > 0 &&
               !last.text.endsWith('\n') && !last.text.endsWith(' ')) {
        segments.push({ text: ' ', linkN: null });
      }
    }

    segments.push({ type: 'form', elementId: id, kind });
  }

  function enterInput(node) {
    const t = (node.getAttribute('type') || 'text').toLowerCase();
    if (t === 'hidden') return;

    if (t === 'checkbox' || t === 'radio') {
      pushFormSegment(t, {
        kind: t,
        name: node.getAttribute('name') || '',
        value: node.getAttribute('value') || 'on',
        checked: !!node.checked,
        disabled: node.hasAttribute('disabled'),
      }, node);
      return;
    }
    if (t === 'submit' || t === 'reset' || t === 'button') {
      pushFormSegment(t, {
        kind: t,
        name: node.getAttribute('name') || '',
        value: node.getAttribute('value') || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : 'Button'),
        disabled: node.hasAttribute('disabled'),
      }, node);
      return;
    }
    if (t === 'password' || TEXT_INPUT_TYPES.has(t)) {
      pushFormSegment(t === 'password' ? 'password' : 'text', {
        kind: t === 'password' ? 'password' : 'text',
        name: node.getAttribute('name') || '',
        value: node.value !== undefined ? node.value : (node.getAttribute('value') || ''),
        placeholder: node.getAttribute('placeholder') || '',
        size: parseDim(node.getAttribute('size')),
        disabled: node.hasAttribute('disabled'),
        readonly: node.hasAttribute('readonly'),
      }, node);
      return;
    }
  }

  function enterSelect(node) {
    if (!formState) return;
    const el = {
      kind: 'select',
      name: node.getAttribute('name') || '',
      disabled: node.hasAttribute('disabled'),
      options: [],
      selectedIndex: -1,
    };
    el.id = formState.addElement(el);
    if (nodeMap) nodeMap.set(el.id, node);
    node._formEl = el;
    segments.push({ type: 'form', elementId: el.id, kind: 'select' });
  }

  function enterOption(node) {
    let el = null;
    for (let k = _stack.length - 1; k >= 0; k--) {
      if (_stack[k].tag === 'select' && _stack[k]._el && _stack[k]._el._formEl) {
        el = _stack[k]._el._formEl;
        break;
      }
    }
    if (!el) return;
    const opt = {
      value: node.hasAttribute('value') ? node.getAttribute('value') : '',
      label: node.getAttribute('label') || '',
      selected: node.hasAttribute('selected'),
    };
    el.options.push(opt);
    if (opt.selected && el.selectedIndex < 0) el.selectedIndex = el.options.length - 1;
  }

  function enterTextarea(node) {
    if (!formState) return;
    const id = formState.addElement({
      kind: 'textarea',
      name: node.getAttribute('name') || '',
      value: node.value !== undefined ? node.value : node.textContent,
      rows: parseDim(node.getAttribute('rows')) || 3,
      cols: parseDim(node.getAttribute('cols')) || 40,
      disabled: node.hasAttribute('disabled'),
      readonly: node.hasAttribute('readonly'),
      formId: currentFormId(),
    });
    if (nodeMap) nodeMap.set(id, node);
    segments.push({ type: 'form', elementId: id, kind: 'textarea' });
  }

  function enterButton(node) {
    if (!formState) return;
    const type = (node.getAttribute('type') || 'submit').toLowerCase();
    const valueAttr = node.getAttribute('value') || '';
    const label = valueAttr || node.textContent || '';
    pushFormSegment(
      type === 'button' ? 'button' : type === 'reset' ? 'reset' : 'submit',
      {
        kind: type === 'button' ? 'button' : type === 'reset' ? 'reset' : 'submit',
        name: node.getAttribute('name') || '',
        value: label,
        disabled: node.hasAttribute('disabled'),
      },
      node
    );
  }

  function pushImage(node) {
    const srcAttr = node.getAttribute('src');
    if (!srcAttr) return;
    const src = resolveUrl(baseUrl, decodeHtmlEntities(srcAttr));
    if (!/^https?:\/\//i.test(src)) return;
    const alt = decodeHtmlEntities(node.getAttribute('alt') || '');
    images.push({
      src, alt,
      width: parseDim(node.getAttribute('width')),
      height: parseDim(node.getAttribute('height')),
    });
    const synthetic = registerSyntheticLink(node);
    segments.push({ type: 'img', src, alt, linkN: synthetic });
  }

  function pushSvg(node) {
    let label = node.getAttribute('aria-label') || '';
    if (!label) {
      for (const c of node.childNodes) {
        if (c.nodeType === 1 && (c.localName === 'title' || c.localName === 'desc')) {
          const t = (c.textContent || '').trim();
          if (t) { label = t; break; }
        }
      }
    }
    if (!label) {
      const sz = svgSize(node);
      label = sz ? `[svg ${sz.w}×${sz.h}]` : '[svg]';
    }

    const a = topLink();
    let linkNForSeg = null;
    let text = label;
    if (a && a.href) {
      linkNForSeg = a.n;
      a.accumulated += label;
      if (!a.prefixEmitted) { text = `[${a.n}]` + label; a.prefixEmitted = true; }
    } else {
      const synthetic = registerSyntheticLink(node);
      if (synthetic !== null) {
        linkNForSeg = synthetic;
        links[synthetic - 1].text = label;
      }
    }

    segments.push({
      text,
      linkN: linkNForSeg,
      pair: linkNForSeg !== null ? theme.pairs.link : theme.pairs.warning,
      bold: false,
      underline: false,
    });
  }

  function enterElement(node) {
    const tag = node.localName;

    if (tag === 'form') {
      emitBlockBreak('form');
      _stack.push(makeEntry(node));
      const s = currentStyle();
      if (s.borderTop) emitHorizontalRule();
      return;
    }

    if (tag === 'li') {
      const depth = _stack.filter(e => e.tag === 'ul' || e.tag === 'ol').length;
      const indent = '  '.repeat(depth);
      const parent = [..._stack].reverse().find(e => e.tag === 'ul' || e.tag === 'ol');
      if (segments.length > 0) {
        const last = segments[segments.length - 1];
        if (!(last.text || '').endsWith('\n')) segments.push({ text: '\n', linkN: null });
      }
      let bullet;
      if (parent && parent.tag === 'ol') {
        parent.count = (parent.count || 0) + 1;
        bullet = `${parent.count}. `;
      } else bullet = '• ';
      segments.push({ text: indent + bullet, linkN: null, pair: theme.pairs.warning, kind: 'bullet' });
      _stack.push(makeEntry(node));
      return;
    }

    /* Flex/grid item → no block-break (theme toggle stays inline). */
    let inFlexGrid = false;
    if (_stack.length > 0) {
      const parentDecls = computeDecls();
      const parentDisplay = String(parentDecls['display'] || '').toLowerCase();
      if (FLEX_GRID_DISPLAYS.has(parentDisplay)) inFlexGrid = true;
    }
    const shouldBlock = BLOCK_TAGS.includes(tag) && !inFlexGrid;

    if (shouldBlock) emitBlockBreak(tag);
    const entry = makeEntry(node);
    entry.wasBlock = shouldBlock;
    _stack.push(entry);

    const s = currentStyle();
    if (s.borderTop) emitHorizontalRule();
  }

  function exitElement(node) {
    const entry = _stack[_stack.length - 1];
    const tag = node.localName;

    const s = currentStyle();
    if (!s.hidden) {
      if (tag === 'a' && entry.n) {
        links[entry.n - 1].text = entry.accumulated.trim();
      }
      if (tag === 'li') {
        segments.push({ text: '\n', linkN: null });
        _stack.pop();
        return;
      }
      if (tag === 'form') {
        if (s.borderBottom) emitHorizontalRule();
        emitBlockBreak('form');
        _stack.pop();
        return;
      }
      if (s.borderBottom) emitHorizontalRule();
      if (entry.wasBlock) emitBlockBreak(tag);
    }
    _stack.pop();
  }

  function walk(node) {
    if (node.nodeType === 3) { emitText(node.data); return; }
    if (node.nodeType !== 1) return;
    if (currentStyle().hidden) return;

    const tag = node.localName;

    if (node.getAttribute) {
      const inline = node.getAttribute('style');
      if (inline && /(?:^|;)\s*position\s*:\s*fixed/i.test(inline)) return;
    }

    if (SKIP_SUBTREE_TAGS.has(tag)) return;

    if (tag === 'br') { segments.push({ text: '\n', linkN: null }); return; }
    if (tag === 'hr') { emitHorizontalRule(); return; }
    if (tag === 'img') { pushImage(node); return; }
    if (tag === 'input') { enterInput(node); return; }
    if (tag === 'svg') { pushSvg(node); return; }

    if (tag === 'option') {
      enterOption(node);
      for (const c of node.childNodes) walk(c);
      return;
    }

    if (tag === 'textarea') { enterTextarea(node); return; }

    if (tag === 'select') {
      enterSelect(node);
      _stack.push(makeEntry(node));
      for (const c of node.childNodes) walk(c);
      _stack.pop();
      return;
    }
    if (tag === 'button') {
      enterButton(node);
      return;
    }

    enterElement(node);
    for (const c of node.childNodes) walk(c);
    exitElement(node);
  }

  for (const c of root.childNodes) walk(c);

  if (links.length > 0) {
    segments.push({ text: '\n\n─── Links ───\n', linkN: null });
    for (const l of links) {
      if (l.href) segments.push({ text: `[${l.n}] ${l.href}\n`, linkN: l.n });
    }
  }

  let text = '';
  for (const seg of segments) if (!seg.type) text += seg.text;
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { segments, links, images, text };
}
