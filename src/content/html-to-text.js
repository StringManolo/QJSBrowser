import { resolveUrl } from 'src/base/url.js';
import { parseStylesheet, parseInlineStyle } from 'src/css/parser.js';
import { matches, specificity } from 'src/css/matcher.js';
import { parseCssColor, snapToAnsi } from 'src/css/color.js';
import { TAG_DEFAULTS } from 'src/css/defaults.js';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  copy: '©', reg: '®', trade: '™',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', ccedil: 'ç', Ccedil: 'Ç',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Acirc: 'Â', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø',
  aelig: 'æ', AElig: 'Æ', szlig: 'ß',
  mdash: '—', ndash: '–', hellip: '…',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', euro: '€', pound: '£', yen: '¥', cent: '¢',
  deg: '°', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
  times: '×', divide: '÷', micro: 'µ', para: '¶', sect: '§',
};

function decodeHtmlEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name) => {
    if (name[0] === '#') {
      const cp = (name[1] === 'x' || name[1] === 'X')
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      if (!cp || cp > 0x10FFFF) return m;
      if (cp < 0x10000) return String.fromCharCode(cp);
      const c = cp - 0x10000;
      return String.fromCharCode(0xD800 + (c >> 10), 0xDC00 + (c & 0x3FF));
    }
    return ENTITIES[name] || m;
  });
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2]
                              : m[3] !== undefined ? m[3]
                              : m[4];
  }
  return attrs;
}

function tokenize(html) {
  const tokens = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { tokens.push({ type: 'text', value: html.slice(i) }); break; }
    if (lt > i) tokens.push({ type: 'text', value: html.slice(i, lt) });

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3; continue;
    }

    const gt = html.indexOf('>', lt);
    if (gt < 0) { tokens.push({ type: 'text', value: html.slice(lt) }); break; }

    const raw = html.slice(lt + 1, gt).trim();
    if (raw.startsWith('/')) {
      tokens.push({ type: 'close', tag: raw.slice(1).trim().toLowerCase() });
    } else if (raw.startsWith('!')) {
      // DOCTYPE, CDATA — skip
    } else {
      const selfClose = raw.endsWith('/');
      const tagText = selfClose ? raw.slice(0, -1).trim() : raw;
      const spaceIdx = tagText.search(/\s/);
      const name = (spaceIdx < 0 ? tagText : tagText.slice(0, spaceIdx)).toLowerCase();
      const attrsStr = spaceIdx < 0 ? '' : tagText.slice(spaceIdx);
      tokens.push({ type: 'open', tag: name, attrs: parseAttrs(attrsStr), selfClose });
    }
    i = gt + 1;
  }
  return tokens;
}

function parseDim(v) {
  if (!v) return 0;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return 0;
  const n = parseInt(s, 10);
  return (n > 0 && n <= 4096) ? n : 0;
}

const BLOCK_TAGS = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'blockquote', 'pre', 'ul', 'ol', 'table'];

/* Tags that are "inline" by browser default — a background-color on these
 * makes sense visually and is safe to render. For block-level backgrounds
 * we defer to the terminal theme (avoids white boxes / invisible text). */
const INLINE_BG_TAGS = new Set(['code', 'kbd', 'samp', 'mark', 'pre']);

function fontSizeLevel(fs) {
  if (!fs) return 0;
  const m = String(fs).match(/^(\d+(?:\.\d+)?)\s*(px|pt|em|rem)?$/i);
  if (!m) return 0;
  let px = parseFloat(m[1]);
  if (m[2] === 'em' || m[2] === 'rem') px *= 16;
  else if (m[2] === 'pt') px *= 1.333;
  if (px >= 32) return 1;
  if (px >= 24) return 2;
  if (px >= 20) return 3;
  if (px >= 18) return 4;
  if (px >= 16) return 5;
  return 6;
}

export function htmlToText(html, baseUrl, theme) {
  const styleCSS = [];
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
    styleCSS.push(css);
    return '';
  });
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');

  const rules = [];
  for (const css of styleCSS) {
    for (const rule of parseStylesheet(css)) rules.push(rule);
  }

  const tokens = tokenize(html);
  const segments = [];
  const links = [];
  const images = [];
  let linkN = 0;
  const stack = [];

  function topLink() {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].tag === 'a') return stack[k];
    return null;
  }

  function currentStyle() {
    const decls = {};

    for (const el of stack) {
      const d = TAG_DEFAULTS[el.tag];
      if (d) Object.assign(decls, d);
    }

    const applicable = [];
    for (const rule of rules) {
      for (const sel of rule.selectors) {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (matches(sel, stack[k])) {
            applicable.push({
              spec: specificity(sel),
              order: rule.order,
              declarations: rule.declarations,
            });
            break;
          }
        }
      }
    }
    applicable.sort((a, b) =>
      a.spec !== b.spec ? a.spec - b.spec : a.order - b.order);
    for (const app of applicable) Object.assign(decls, app.declarations);

    for (const el of stack) {
      if (el.inlineStyle) Object.assign(decls, el.inlineStyle);
    }

    const fg = parseCssColor(decls['color']);
    const fgAnsi = snapToAnsi(fg, -1);

    /* Backgrounds: only apply for inline code-like elements. Block-level
     * backgrounds would paint the whole content area white/black, breaking
     * the terminal theme and often making text invisible. */
    const innermost = stack[stack.length - 1];
    const isInlineBg = innermost && INLINE_BG_TAGS.has(innermost.tag);
    const bgAnsi = isInlineBg
      ? snapToAnsi(parseCssColor(decls['background-color']), -1)
      : -1;

    const bold = decls['font-weight'] === 'bold' ||
                 (parseInt(decls['font-weight'], 10) >= 600) ||
                 (fgAnsi >= 8 && fgAnsi <= 15 && stack.some(e =>
                    ['h1','h2','h3','h4','h5','h6','b','strong'].includes(e.tag)));

    const deco = (decls['text-decoration'] || '').toLowerCase();
    const italic = (decls['font-style'] || '').toLowerCase() === 'italic';
    const underline = deco.includes('underline') || italic;

    const pre = stack.some(e => e.tag === 'pre');
    const indent = stack.some(e => e.tag === 'blockquote') ? 2 : 0;
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
    // Don't break right after a list bullet (the <li> handler already
    // manages its own newlines and the following text belongs on the same line)
    if (last.kind === 'bullet') return;
    const lastText = last.text || '';
    if (lastText.endsWith('\n\n')) return;
    if (lastText.endsWith('\n')) segments.push({ text: '\n', linkN: null });
    else                         segments.push({ text: '\n\n', linkN: null });
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
      if (!a.prefixEmitted) {
        text = `[${a.n}]` + text;
        a.prefixEmitted = true;
      }
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

    /* Note: no emitBlockBreak here. Block breaks are triggered by tag open/
     * close, not by text content. This prevents inline nested elements like
     * `foo <b>bar</b> baz` from forcing spurious newlines. */

    let pairId;
    if (s.fgAnsi >= 0 || s.bgAnsi >= 0) {
      pairId = theme.lookupPair(s.fgAnsi, s.bgAnsi);
    } else if (s.pairOverride) {
      pairId = s.pairOverride;
    } else if (linkNForSeg !== null) {
      pairId = theme.pairs.link;
    } else {
      pairId = theme.pairs.page;
    }

    segments.push({
      text,
      linkN: linkNForSeg,
      pair: pairId,
      bold: s.bold,
      underline: s.underline,
    });
  }

  function pushImage(attrs) {
    if (!attrs.src) return;
    const src = resolveUrl(baseUrl, decodeHtmlEntities(attrs.src));
    if (!/^https?:\/\//i.test(src)) return;
    const alt = decodeHtmlEntities(attrs.alt || '');
    const width = parseDim(attrs.width);
    const height = parseDim(attrs.height);
    images.push({ src, alt, width, height });
    segments.push({ type: 'img', src, alt, width, height });
  }

  function handleOpen(tok) {
    const tag = tok.tag;
    const attrs = tok.attrs || {};
    if (tag === 'br') { segments.push({ text: '\n', linkN: null }); return; }
    if (tag === 'hr') { emitBlockBreak(); segments.push({ text: '────\n', linkN: null }); return; }
    if (tag === 'img') { pushImage(attrs); return; }

    if (tag === 'li') {
      const depth = stack.filter(e => e.tag === 'ul' || e.tag === 'ol').length;
      const indent = '  '.repeat(depth);
      const parent = [...stack].reverse().find(e => e.tag === 'ul' || e.tag === 'ol');

      // Ensure newline before bullet (unless already at line start)
      if (segments.length > 0) {
        const last = segments[segments.length - 1];
        if (!(last.text || '').endsWith('\n')) {
          segments.push({ text: '\n', linkN: null });
        }
      }

      let bullet;
      if (parent && parent.tag === 'ol') {
        parent.count = (parent.count || 0) + 1;
        bullet = `${parent.count}. `;
      } else {
        bullet = '• ';
      }

      segments.push({
        text: indent + bullet,
        linkN: null,
        pair: theme.pairs.warning,
        kind: 'bullet',
      });
      stack.push({ tag: 'li' });
      return;
    }

    if (BLOCK_TAGS.includes(tag)) emitBlockBreak();

    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    const id = attrs.id || null;
    const inlineStyle = attrs.style ? parseInlineStyle(attrs.style) : null;

    const el = { tag, id, classes, inlineStyle };
    stack.push(el);

    if (tag === 'a') {
      const href = attrs.href ? resolveUrl(baseUrl, decodeHtmlEntities(attrs.href)) : null;
      if (href && /^https?:\/\//i.test(href)) {
        linkN++;
        links.push({ n: linkN, href, text: '' });
        el.href = href;
        el.n = linkN;
        el.prefixEmitted = false;
        el.accumulated = '';
      }
    }
  }

  function handleClose(tok) {
    const tag = tok.tag;
    let popped = null;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].tag === tag) { popped = stack[k]; stack.length = k; break; }
    }

    if (tag === 'a' && popped && popped.n)
      links[popped.n - 1].text = popped.accumulated.trim();

    if (tag === 'li') { segments.push({ text: '\n', linkN: null }); return; }
    if (BLOCK_TAGS.includes(tag)) emitBlockBreak();
  }

  for (const tok of tokens) {
    if (tok.type === 'text') emitText(tok.value);
    else if (tok.type === 'open') { handleOpen(tok); if (tok.selfClose) handleClose(tok); }
    else if (tok.type === 'close') handleClose(tok);
  }

  if (links.length > 0) {
    segments.push({ text: '\n\n─── Links ───\n', linkN: null });
    for (const l of links) segments.push({ text: `[${l.n}] ${l.href}\n`, linkN: l.n });
  }

  let text = '';
  for (const seg of segments) if (!seg.type) text += seg.text;
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { segments, links, images, text };
}
