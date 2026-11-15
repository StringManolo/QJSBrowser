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

function cleanInlineText(s) {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).trim();
}

/* Parse an HTML dimension attribute ("100", "100px", "100%", "auto", etc.).
 * Returns the numeric value only for plain integers. Percentages, "auto",
 * and CSS units other than unitless px are rejected — we don't have a
 * layout engine to interpret them. */
function parseDim(v) {
  if (!v) return 0;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return 0;
  const n = parseInt(s, 10);
  if (n <= 0 || n > 4096) return 0;
  return n;
}

export function htmlToText(html, baseUrl) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<!--[\s\S]*?-->/g, '');

  const segments = [];
  const links = [];
  const images = [];
  let linkN = 0;

  function pushPlain(raw) {
    if (!raw) return;
    let text = raw
      .replace(/<\/(p|div|h[1-6]|li|tr|td|blockquote|pre|section|article|header|footer|nav|aside)>/gi, '\n\n')
      .replace(/<(p|div|h[1-6]|li|tr|td|blockquote|pre|section|article|header|footer|nav|aside)\b[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<hr\s*\/?>/gi, '\n────\n')
      .replace(/<[^>]+>/g, '');
    text = decodeHtmlEntities(text).replace(/[ \t]+/g, ' ');
    if (text.length === 0) return;
    segments.push({ text, linkN: null });
  }

  function pushImage(match) {
    const attrRe = /(\w+)\s*=\s*["']([^"']*)["']/g;
    const attrs = {};
    let a;
    while ((a = attrRe.exec(match)) !== null) attrs[a[1].toLowerCase()] = a[2];

    if (!attrs.src) return;
    const src = resolveUrl(baseUrl, decodeHtmlEntities(attrs.src));
    if (!/^https?:\/\//i.test(src)) return;

    const alt = decodeHtmlEntities(attrs.alt || '');
    const width  = parseDim(attrs.width);
    const height = parseDim(attrs.height);

    images.push({ src, alt, width, height });
    segments.push({ type: 'img', src, alt, width, height });
  }

  const tokenRe = /(<a\s+[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>)|(<img\b[^>]*>)/gi;
  let lastEnd = 0;
  let m;

  while ((m = tokenRe.exec(html)) !== null) {
    pushPlain(html.slice(lastEnd, m.index));

    if (m[1]) {
      const href = decodeHtmlEntities(m[2]);
      const resolved = resolveUrl(baseUrl, href);
      if (!/^https?:\/\//i.test(resolved)) {
        pushPlain(m[3]);
      } else {
        linkN++;
        const label = cleanInlineText(m[3]) || resolved;
        links.push({ n: linkN, href: resolved, text: label });
        segments.push({ text: `[${linkN}]${label}`, linkN });
      }
    } else if (m[4]) {
      pushImage(m[4]);
    }

    lastEnd = m.index + m[0].length;
  }
  pushPlain(html.slice(lastEnd));

  if (links.length > 0) {
    segments.push({ text: '\n\n─── Links ───\n', linkN: null });
    for (const l of links) segments.push({ text: `[${l.n}] ${l.href}\n`, linkN: l.n });
  }

  let text = '';
  for (const seg of segments) if (!seg.type) text += seg.text;
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { segments, links, images, text };
}
