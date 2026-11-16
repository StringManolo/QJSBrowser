/* HTML → DOM tree.
 *
 * Same naive-stack semantics as html-to-text.js so that
 * domToText(htmlToDom(html)) produces byte-identical segments for
 * well-formed HTML.
 *
 * Differences from html-to-text:
 *   - <script> is NOT stripped. Each <script> element stays in the tree
 *     (empty, no text child) and is captured into `scripts[]` with its
 *     inline source and attributes. Script execution is a controller job.
 *   - The tokenizer is script-aware: content between <script>…</script>
 *     is captured as raw text, so `<` and `>` inside JS string literals
 *     do not confuse tag detection. Same for <style> and <textarea>.
 *   - <style> is still extracted via regex before tokenizing (same as
 *     html-to-text), returned as `css[]`.
 *
 * Exports:
 *   htmlToDom(html, baseUrl, document)  — clears body, parses into it
 *   parseHtmlInto(html, baseUrl, document, target) — parse fragment into
 *     an arbitrary element. Used by Element.insertAdjacentHTML (runtime
 *     DOM mutation) which must preserve <style> tags — Vite and
 *     example.com both inject them dynamically.
 */

import { resolveUrl } from 'src/base/url.js';
import { decodeHtmlEntities } from 'src/content/html-entities.js';

function parseAttrs(str) {
  const attrs = {};
  const re = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2]
                              : m[3] !== undefined ? m[3]
                              : m[4] !== undefined ? m[4]
                              : '';
  }
  return attrs;
}

const RAW_CONTENT_TAGS = new Set(['script', 'style', 'textarea']);
const VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input',
  'link','meta','param','source','track','wbr'
]);

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
      i = gt + 1;
      continue;
    }
    if (raw.startsWith('!')) { i = gt + 1; continue; }

    const selfClose = raw.endsWith('/');
    const tagText = selfClose ? raw.slice(0, -1).trim() : raw;
    const spaceIdx = tagText.search(/\s/);
    const name = (spaceIdx < 0 ? tagText : tagText.slice(0, spaceIdx)).toLowerCase();
    const attrsStr = spaceIdx < 0 ? '' : tagText.slice(spaceIdx);
    const attrs = parseAttrs(attrsStr);
    tokens.push({ type: 'open', tag: name, attrs, selfClose });

    if (!selfClose && RAW_CONTENT_TAGS.has(name)) {
      const closeTag = '</' + name;
      const closeIdx = html.toLowerCase().indexOf(closeTag, gt + 1);
      if (closeIdx < 0) {
        const rest = html.slice(gt + 1);
        if (rest.length > 0) tokens.push({ type: 'text', value: rest });
        i = html.length;
        continue;
      }
      const content = html.slice(gt + 1, closeIdx);
      if (content.length > 0) tokens.push({ type: 'text', value: content });
      tokens.push({ type: 'close', tag: name });
      const closeGt = html.indexOf('>', closeIdx);
      i = closeGt < 0 ? html.length : closeGt + 1;
      continue;
    }
    i = gt + 1;
  }
  return tokens;
}

/* Parses `html` into `target`, appending parsed children. Returns the
 * array of <script> descriptors (empty for fragments — insertAdjacentHTML
 * must not execute scripts, matching browser behavior).
 *
 * The #root frame's node is `target`, so top-level text and elements
 * land directly as its children. */
function parseInto(html, baseUrl, document, target) {
  const tokens = tokenize(html);
  const stack = [{ tag: '#root', node: target }];
  const scripts = [];

  function current() { return stack[stack.length - 1].node; }

  function pushElement(tag, attrs) {
    const el = document.createElement(tag);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    current().appendChild(el);
    return el;
  }

  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];

    /* Skip <html>, <head>, <body> wrapper tags. Their children are
     * processed normally and appended to the current target. This
     * prevents nesting <html> inside <body> (which buries <div id="root">
     * under a tag domToText skips, so React's output never gets
     * serialized). It also matches browser behavior in fragment
     * context — insertAdjacentHTML ignores these tags — so the same
     * filter is correct for parseHtmlInto. */
    if ((tok.type === 'open' || tok.type === 'close') &&
        (tok.tag === 'html' || tok.tag === 'head' || tok.tag === 'body')) {
      continue;
    }

    const top = stack[stack.length - 1];

    if (top && top.rawContent) {
      if (tok.type === 'text') { top.rawText += tok.value; continue; }
      if (tok.type === 'close' && tok.tag === top.tag) {
        if (top.tag === 'script') {
          const el = top.node;
          el._inlineCode = top.rawText;
          const srcAttr = el.getAttribute('src');
          scripts.push({
            element: el,
            inline: top.rawText,
            src: srcAttr ? resolveUrl(baseUrl, decodeHtmlEntities(srcAttr)) : null,
            type: (el.getAttribute('type') || 'text/javascript').toLowerCase().trim(),
            async: el.hasAttribute('async'),
            defer: el.hasAttribute('defer'),
          });
        } else {
          const txt = document.createTextNode(top.rawText);
          top.node.appendChild(txt);
        }
        stack.pop();
        continue;
      }
      if (tok.type === 'open') {
        const attrStr = Object.entries(tok.attrs)
          .map(([k, v]) => v === '' ? ' ' + k : ` ${k}="${v}"`).join('');
        top.rawText += '<' + tok.tag + attrStr + (tok.selfClose ? '/' : '') + '>';
        continue;
      }
      if (tok.type === 'close') { top.rawText += '</' + tok.tag + '>'; continue; }
    }

    if (tok.type === 'text') {
      current().appendChild(document.createTextNode(tok.value));
    } else if (tok.type === 'open') {
      const tag = tok.tag;
      const el = pushElement(tag, tok.attrs);
      if (VOID_TAGS.has(tag) || tok.selfClose) continue;
      if (RAW_CONTENT_TAGS.has(tag)) {
        stack.push({ tag, node: el, rawContent: true, rawText: '' });
        continue;
      }
      stack.push({ tag, node: el });
    } else if (tok.type === 'close') {
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === tok.tag) { stack.length = k; break; }
      }
    }
  }

  return scripts;
}

export function htmlToDom(html, baseUrl, document) {
  const styleCSS = [];
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
    styleCSS.push(css);
    return '';
  });

  const body = document.body;
  while (body.firstChild) body.removeChild(body.firstChild);

  const scripts = parseInto(html, baseUrl, document, body);
  return { css: styleCSS, scripts };
}

/* Parse an HTML fragment into `target`. Does NOT extract <style> — the
 * caller wants them in the tree (e.g. insertAdjacentHTML, which is how
 * Vite injects per-route CSS and how example.com injects its icon
 * tweaks). Does NOT execute or collect scripts — browsers don't run
 * scripts inserted via insertAdjacentHTML either.
 *
 * Note: baseUrl is passed through to resolveUrl for relative src/href.
 * Currently insertAdjacentHTML passes '', so relative URLs in inserted
 * HTML won't resolve to the page's origin. Fix is to plumb the tab's
 * currentUrl into the Element.insertAdjacentHTML extension in main.js
 * — left as a follow-up since no in-the-wild case has needed it yet. */
export function parseHtmlInto(html, baseUrl, document, target) {
  return parseInto(String(html || ''), baseUrl, document, target);
}
