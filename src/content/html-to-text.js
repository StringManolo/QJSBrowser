import { resolveUrl } from 'src/base/url.js';

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
      const resolved = resolveUrl(baseUrl, href);
      const cleanText = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      links.push({ n: linkN, href: resolved, text: cleanText || href });
      return `[${linkN}]${inner}`;
    }
  );


    const text = html
    .replace(/<\/(p|div|h[1-6]|li|tr|td|blockquote|pre|section|article|header|footer|nav|aside)>/gi, '\n\n')
    .replace(/<(p|div|h[1-6]|li|tr|td|blockquote|pre|section|article|header|footer|nav|aside)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n────\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, links };
}
