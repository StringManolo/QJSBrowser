/* DOM → segments. Byte-identical to html-to-text for well-formed HTML.
 *
 * Walks the tree in pre-order (which is the token order that html-to-text
 * iterated). CSS matching uses a virtual stack of {tag, id, classes,
 * inlineStyle} entries pushed/popped as we enter/exit elements, mirroring
 * html-to-text's behavior — including its quirks:
 *   - Button/select stack entries have no classes/style, so class-based
 *     CSS rules on <button>/<select> do NOT propagate to their children.
 *   - <option> does not push to the stack; its text is emitted as plain
 *     text (matching the current html-to-text behavior, buggy or not).
 *   - <textarea> content is captured as one raw text node and rendered
 *     via formState, never as plain text.
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

export function domToText(root, baseUrl, theme, formState, cssTexts) {
  const rules = [];
  for (const css of cssTexts || []) for (const rule of parseStylesheet(css)) rules.push(rule);

  const segments = [];
  const links = [];
  const images = [];
  const _stack = [];          /* entries: { tag, id, classes, inlineStyle, ... } */
  let linkN = 0;

  /* --- stack entries -------------------------------------------------- */

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

    /* Match html-to-text: <button>/<select> push to stack with no classes
     * or inline style. Tag defaults apply, but not class-based CSS. */
    if (tag === 'button' || tag === 'select') {
      entry.classes = new Set();
      entry.inlineStyle = null;
    }

    return entry;
  }

  /* --- style resolution ----------------------------------------------- */

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

  /* --- segment emission ----------------------------------------------- */

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
    else if (s.pairOverride) pairId = s.pairOverride;
    else if (linkNForSeg !== null) pairId = theme.pairs.link;
    else pairId = theme.pairs.page;

    segments.push({ text, linkN: linkNForSeg, pair: pairId, bold: s.bold, underline: s.underline });
  }

  /* --- form helpers --------------------------------------------------- */

  function pushFormSegment(kind, info) {
    if (!formState) return;
    info.formId = currentFormId();
    const id = formState.addElement(info);
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
        checked: node.hasAttribute('checked'),
        disabled: node.hasAttribute('disabled'),
      });
      return;
    }
    if (t === 'submit' || t === 'reset' || t === 'button') {
      pushFormSegment(t, {
        kind: t,
        name: node.getAttribute('name') || '',
        value: node.getAttribute('value') || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : 'Button'),
        disabled: node.hasAttribute('disabled'),
      });
      return;
    }
    if (t === 'password' || TEXT_INPUT_TYPES.has(t)) {
      pushFormSegment(t === 'password' ? 'password' : 'text', {
        kind: t === 'password' ? 'password' : 'text',
        name: node.getAttribute('name') || '',
        value: node.getAttribute('value') || '',
        placeholder: node.getAttribute('placeholder') || '',
        size: parseDim(node.getAttribute('size')),
        disabled: node.hasAttribute('disabled'),
        readonly: node.hasAttribute('readonly'),
      });
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
    node._formEl = el;   /* used by enterOption below */
    segments.push({ type: 'form', elementId: el.id, kind: 'select' });
  }

  function enterOption(node) {
    /* Walk ancestors to find the enclosing <select>'s element state. */
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
      value: node.textContent,      /* raw text — entities not decoded */
      rows: parseDim(node.getAttribute('rows')) || 3,
      cols: parseDim(node.getAttribute('cols')) || 40,
      disabled: node.hasAttribute('disabled'),
      readonly: node.hasAttribute('readonly'),
      formId: currentFormId(),
    });
    segments.push({ type: 'form', elementId: id, kind: 'textarea' });
  }

  function enterButton(node) {
    if (!formState) return;
    const type = (node.getAttribute('type') || 'submit').toLowerCase();
    pushFormSegment(
      type === 'button' ? 'button' : type === 'reset' ? 'reset' : 'submit',
      {
        kind: type === 'button' ? 'button' : type === 'reset' ? 'reset' : 'submit',
        name: node.getAttribute('name') || '',
        value: node.getAttribute('value') || '',
        disabled: node.hasAttribute('disabled'),
      }
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

  /* --- walk ----------------------------------------------------------- */

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

    /* Leaf / void elements that don't push to the stack in html-to-text. */
    if (tag === 'br') { segments.push({ text: '\n', linkN: null }); return; }
    if (tag === 'hr') { emitBlockBreak(); segments.push({ text: '────\n', linkN: null }); return; }
    if (tag === 'img') { pushImage(node); return; }
    if (tag === 'input') { enterInput(node); return; }

    /* <option> is captured into the enclosing select's options list but
     * does NOT push to the stack; its text is emitted as plain text
     * (matching html-to-text's current behavior). */
    if (tag === 'option') {
      enterOption(node);
      for (const c of node.childNodes) walk(c);
      return;
    }

    /* <textarea>: form element with raw text content. Children are NOT
     * walked (their text is captured via node.textContent in enterTextarea). */
    if (tag === 'textarea') { enterTextarea(node); return; }

    /* <select> and <button>: form element + push to stack so children
     * see the parent context (per html-to-text). */
    if (tag === 'select') {
      enterSelect(node);
      _stack.push(makeEntry(node));
      for (const c of node.childNodes) walk(c);
      _stack.pop();
      return;
    }
    if (tag === 'button') {
      enterButton(node);
      _stack.push(makeEntry(node));
      for (const c of node.childNodes) walk(c);
      _stack.pop();
      return;
    }

    /* Everything else: normal enter / recurse / exit. */
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
