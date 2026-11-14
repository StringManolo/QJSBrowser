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

/* Returns:
 *   segments: [{ text, linkN: number|null }, ...]  — inline flow to render
 *   links:    [{ n, href, text }, ...]              — for programmatic lookup
 *   text:     string                                 — plain text (for status bar)
 */
export function htmlToText(html, baseUrl) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<!--[\s\S]*?-->/g, '');

  const segments = [];
  const links = [];
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

  const linkRe = /<a\s+[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lastEnd = 0;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    pushPlain(html.slice(lastEnd, m.index));

    const cleanHref = decodeHtmlEntities(m[1]);
    const resolved = resolveUrl(baseUrl, cleanHref);

    // Skip non-navigable schemes (mailto:, javascript:, tel:, ...)
    if (!/^https?:\/\//i.test(resolved)) {
      pushPlain(m[2]);
      lastEnd = m.index + m[0].length;
      continue;
    }

    linkN++;
    const label = cleanInlineText(m[2]) || resolved;
    links.push({ n: linkN, href: resolved, text: label });
    segments.push({ text: `[${linkN}]${label}`, linkN });

    lastEnd = m.index + m[0].length;
  }
  pushPlain(html.slice(lastEnd));

  // Bottom legend — full URLs, each row clickable
  if (links.length > 0) {
    segments.push({ text: '\n\n─── Links ───\n', linkN: null });
    for (const l of links) {
      segments.push({ text: `[${l.n}] ${l.href}\n`, linkN: l.n });
    }
  }

  // Plain-text version (for status bar / char count)
  let text = '';
  for (const seg of segments) text += seg.text;
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { segments, links, text };
}
