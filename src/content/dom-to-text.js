/* DOM → segments. Byte-identical to html-to-text for well-formed HTML.
 *
 * Reads *properties* (node.value, node.checked) for form state, not
 * attributes. React controlled inputs write the property, not the
 * attribute (to preserve cursor position), so reading the attribute
 * would show stale default values after every re-render.
 *
 * <button> uses textContent as its label (not the value attribute) —
 * React writes the label as a text child, not as value="". And we do
 * NOT walk into its children (the label is already in the form segment),
 * so the text isn't duplicated.
 *
 * If nodeMap is provided, populates it with elementId → Element DOM.
 * The controller uses this to dispatch real click/input events at the
 * original node when the user interacts with the TUI.
 */

import { resolveUrl } from 'src/base/url.js';
import { parseStylesheet, parseInlineStyle } from 'src/css/parser.js';
import { matches, specificity } from 'src/css/matcher.js';
import { parseCssColor, snapToAnsi } from 'src/css/color.js';
import { TAG_DEFAULTS } from 'src/css/defaults.js';
import { decodeHtmlEntities } from 'src/content/html-entities.js';

const BLOCK_TAGS = ['p','div','h1','h2','h3','h4','h5','h6',
                    'blockquote','pre','ul','ol','table','form'];
const INLINE_BG_TAGS = new Set(['code','kbd','samp','mark','pre']);
const TEXT_INPUT_TYPES = new Set(['text','email','tel','url','number','search','password']);
const CLICKABLE_KINDS = new Set(['submit', 'reset', 'button']);

/* Subtrees whose text content should never be emitted as page text.
 * - style:     CSS text; example.com's s.js injects one via
 *              insertAdjacentHTML and, without this skip, the rules
 *              appear as a paragraph.
 * - script:    JS source; htmlToDom never creates a text child, but
 *              defensive skip is cheap.
 * - title:     metadata; because html-to-dom drops the <head> wrapper,
 *              a document <title> ends up as a direct child of <body>
 *              and would otherwise render as page text.
 * - noscript:  content for browsers without JS; we have JS.
 * - template:  inert by spec. */
const SKIP_SUBTREE_TAGS = new Set(['style','script','title','noscript','template']);

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

/* Extract intrinsic dimensions from an inline <svg>. Priority order:
 * width/height attributes, then viewBox "minX minY W H" (with commas
 * or spaces). Returns null if neither is usable. */
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

export function domToText(root, baseUrl, theme, formState, cssTexts, nodeMap) {
  const rules = [];
  for (const css of cssTexts || []) for (const rule of parseStylesheet(css)) rules.push(rule);

  const segments = [];
  const links = [];
  const images = [];
  const _stack = [];
  let linkN = 0;

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

    const fg = parseCssColor(decls['color']);
    const fgAnsi = snapToAnsi(fg, -1);
    const innermost = _stack[_stack.length - 1];
    const isInlineBg = innermost && INLINE_BG_TAGS.has(innermost.tag);
    const bgAnsi = isInlineBg
      ? snapToAnsi(parseCssColor(decls['background-color']), -1) : -1;

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

    return { fgAnsi, bgAnsi, bold, underline, indent, pre, hidden, pairOverride };
  }

  function emitBlockBreak() {
    if (segments.length === 0) return;
    const last = segments[segments.length - 1];
    if (last.kind === 'bullet') return;
    if (last.type === 'form') return;
    const lastText = last.text || '';
    if (lastText.endsWith('\n\n')) return;
    if (lastText.endsWith('\n')) segments.push({ text: '\n', linkN: null });
    else segments.push({ text: '\n\n', linkN: null });
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

    let text = s.pre ? decodeHtmlEntities(raw)
                     : decodeHtmlEntities(raw.replace(/[ \t]+/g, ' '));
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

    let pairId;
    if (s.fgAnsi >= 0 || s.bgAnsi >= 0) pairId = theme.lookupPair(s.fgAnsi, s.bgAnsi);
    else if (s.pairOverride) pairId = theme.pairs.pairOverride;
    else if (linkNForSeg !== null) pairId = theme.pairs.link;
    else pairId = theme.pairs.page;

    segments.push({ text, linkN: linkNForSeg, pair: pairId, bold: s.bold, underline: s.underline });
  }

  function pushFormSegment(kind, info, node) {
    if (!formState) return;
    info.formId = currentFormId();
    const id = formState.addElement(info);
    if (nodeMap && node) nodeMap.set(id, node);

    if (CLICKABLE_KINDS.has(kind) && segments.length > 0) {
      const last = segments[segments.length - 1];
      if (last.type === 'form') {
        segments.push({ text: ' ', linkN: null });
      } else if (last.text && last.text.length > 0 &&
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
    segments.push({ type: 'img', src, alt });
  }

  /* Inline <svg>: emit a text placeholder. Full rasterization needs
   * NanoSVG in image.so and a live DOM → string serializer; cost/benefit
   * for a 2-cell icon is poor. The placeholder keeps the layout
   * readable. Label priority: aria-label, then <title>/<desc> child,
   * then intrinsic dimensions ("[svg 44×44]"), then bare "[svg]".
   * If the svg sits inside an <a>, the placeholder inherits link
   * semantics: the [N] prefix is attached on first emission inside the
   * link and clicking it navigates, matching <img> inside <a>. */
  function pushSvg(node) {
    let label = node.getAttribute('aria-label') || '';
    if (!label) {
      for (const c of node.childNodes) {
        if (c.nodeType === 1 &&
            (c.localName === 'title' || c.localName === 'desc')) {
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
      emitBlockBreak();
      _stack.push(makeEntry(node));
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
    if (BLOCK_TAGS.includes(tag)) emitBlockBreak();
    _stack.push(makeEntry(node));
  }

  function exitElement(node) {
    const entry = _stack[_stack.length - 1];
    const tag = node.localName;

    if (!currentStyle().hidden) {
      if (tag === 'a' && entry.n) {
        links[entry.n - 1].text = entry.accumulated.trim();
      }
      if (tag === 'li') {
        segments.push({ text: '\n', linkN: null });
        _stack.pop();
        return;
      }
      if (tag === 'form') {
        emitBlockBreak();
        _stack.pop();
        return;
      }
      if (BLOCK_TAGS.includes(tag)) emitBlockBreak();
    }
    _stack.pop();
  }

  function walk(node) {
    if (node.nodeType === 3) { emitText(node.data); return; }
    if (node.nodeType !== 1) return;
    if (currentStyle().hidden) return;

    const tag = node.localName;

    if (SKIP_SUBTREE_TAGS.has(tag)) return;

    if (tag === 'br') { segments.push({ text: '\n', linkN: null }); return; }
    if (tag === 'hr') { emitBlockBreak(); segments.push({ text: '────\n', linkN: null }); return; }
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
    for (const l of links) segments.push({ text: `[${l.n}] ${l.href}\n`, linkN: l.n });
  }

  let text = '';
  for (const seg of segments) if (!seg.type) text += seg.text;
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { segments, links, images, text };
}
