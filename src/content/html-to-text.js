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

export function htmlToText(html, baseUrl) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<!--[\s\S]*?-->/g, '');

  const links = [];
  let linkN = 0;

  html = html.replace(
    /<a\s+[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (m, href, inner) => {
      linkN++;
      const cleanHref = decodeHtmlEntities(href);
      const resolved = resolveUrl(baseUrl, cleanHref);
      const cleanText = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      links.push({ n: linkN, href: resolved, text: cleanText || href });
      return `[${linkN}]${inner}`;
    }
  );

  let text = html
    .replace(/<\/(p|div|h[1-6]|li|tr|td|blockquote|pre|section|article|header|footer|nav|aside)>/gi, '\n\n')
    .replace(/<(p|div|h[1-6]|li|tr|td|blockquote|pre|section|article|header|footer|nav|aside)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n────\n')
    .replace(/<[^>]+>/g, '');

  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return { text, links };
}
