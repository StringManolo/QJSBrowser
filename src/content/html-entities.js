/* Shared HTML entity table + decoder. Used by both html-to-text.js and
 * html-to-dom.js. Extracted to break the circular import (html-to-text.js
 * is being kept untouched for byte-identical regression tests). */

export const ENTITIES = {
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

export function decodeHtmlEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name) => {
    if (name[0] === '#') {
      const cp = (name[1] === 'x' || name[1] === 'X')
        ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!cp || cp > 0x10FFFF) return m;
      if (cp < 0x10000) return String.fromCharCode(cp);
      const c = cp - 0x10000;
      return String.fromCharCode(0xD800 + (c >> 10), 0xDC00 + (c & 0x3FF));
    }
    return ENTITIES[name] || m;
  });
}
