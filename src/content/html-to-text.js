import { resolveUrl } from 'src/base/url.js';

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
      i = end + 3;
      continue;
    }

    const gt = html.indexOf('>', lt);
    if (gt < 0) { tokens.push({ type: 'text', value: html.slice(lt) }); break; }

    const raw = html.slice(lt + 1, gt).trim();
    if (raw.startsWith('/')) {
      tokens.push({ type: 'close', tag: raw.slice(1).trim().toLowerCase() });
    } else if (raw.startsWith('!')) {
      // <!DOCTYPE ...> etc — skip
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
  if (n <= 0 || n > 4096) return 0;
  return n;
}

const BLOCK_TAGS = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'blockquote', 'pre', 'ul', 'ol', 'table'];

export function htmlToText(html, baseUrl) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '');

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
    const s = { bold: false, underline: false, pairName: 'page', pre: false, block: false, indent: 0 };
    for (const e of stack) {
      switch (e.tag) {
        case 'b': case 'strong': s.bold = true; break;
        case 'i': case 'em': case 'u': case 'ins': s.underline = true; break;
        case 'del': case 's': case 'strike': s.underline = true; break;
        case 'code': case 'kbd': case 'samp': s.pairName = 'code'; break;
        case 'pre': s.pairName = 'code'; s.pre = true; s.block = true; break;
        case 'h1': s.pairName = 'heading1'; s.bold = true; s.block = true; break;
        case 'h2': s.pairName = 'heading2'; s.bold = true; s.block = true; break;
        case 'h3': s.pairName = 'heading3'; s.bold = true; s.block = true; break;
        case 'h4': s.pairName = 'heading4'; s.bold = true; s.block = true; break;
        case 'h5': s.pairName = 'heading5'; s.bold = true; s.block = true; break;
        case 'h6': s.pairName = 'heading6'; s.bold = true; s.block = true; break;
        case 'blockquote': s.pairName = 'blockquote'; s.indent = 2; s.block = true; break;
        case 'a':
          if (e.href) { s.pairName = 'link'; s.underline = true; }
          break;
      }
    }
    return s;
  }

  function emitBlockBreak() {
    if (segments.length === 0) return;
    const last = segments[segments.length - 1];
    const lastText = last.text || '';
    if (lastText.endsWith('\n\n')) return;
    if (lastText.endsWith('\n')) segments.push({ text: '\n', linkN: null });
    else                         segments.push({ text: '\n\n', linkN: null });
  }

    function emitText(raw) {
    if (!raw) return;
    const s = currentStyle();
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
      if (segments.length === 0) {
        text = pad + text;
      } else {
        const last = segments[segments.length - 1];
        // ★ Safe: if last segment is an image (no .text), insert a newline
        if (!last.text) segments.push({ text: '\n', linkN: null });
        else if (last.text.endsWith('\n')) text = pad + text;
      }
      text = text.replace(/\n/g, '\n' + pad);
    }

    if (s.block && segments.length > 0) {
      const last = segments[segments.length - 1];
      if (last.text && !last.text.endsWith('\n')) emitBlockBreak();
    }

    segments.push({
      text,
      linkN: linkNForSeg,
      pairName: s.pairName,
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

    if (tag === 'a') {
      const href = attrs.href ? resolveUrl(baseUrl, decodeHtmlEntities(attrs.href)) : null;
      if (href && /^https?:\/\//i.test(href)) {
        linkN++;
        links.push({ n: linkN, href, text: '' });
        stack.push({ tag: 'a', href, n: linkN, prefixEmitted: false, accumulated: '' });
      } else {
        stack.push({ tag: 'a', href: null });
      }
      return;
    }

    if (tag === 'li') {
      const depth = stack.filter(e => e.tag === 'ul' || e.tag === 'ol').length;
      const indent = '  '.repeat(depth);
      const parent = [...stack].reverse().find(e => e.tag === 'ul' || e.tag === 'ol');
      if (parent && parent.tag === 'ol') {
        parent.count = (parent.count || 0) + 1;
        segments.push({ text: `\n${indent}${parent.count}. `, linkN: null, pairName: 'listBullet' });
      } else {
        segments.push({ text: `\n${indent}• `, linkN: null, pairName: 'listBullet' });
      }
      stack.push({ tag: 'li' });
      return;
    }

    if (BLOCK_TAGS.includes(tag)) emitBlockBreak();
    stack.push({ tag, attrs });
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
