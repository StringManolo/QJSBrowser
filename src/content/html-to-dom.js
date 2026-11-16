/* HTML → DOM tree.
 *
 * Same tokenizer and same "naive stack" behavior as html-to-text.js so
 * that domToText(htmlToDom(html)) produces byte-identical segments for
 * well-formed HTML. Malformed HTML can differ: html-to-text does a
 * "pop-until-match" on close, which a properly-nested tree cannot
 * reproduce. Valid HTML (what React/Vite/etc. emit) is unaffected.
 *
 * <style> content is extracted and returned separately; <script> is
 * stripped for now (script execution is a later PR).
 */

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
      /* DOCTYPE */
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

/* Elements whose content is text, not markup. The tokenizer will produce
 * inner tokens for these, but the tree builder captures the content as a
 * single raw text node and skips those tokens. Currently only <textarea>
 * needs this (script/style already stripped before tokenizing). */
const RAW_CONTENT_TAGS = new Set(['textarea']);

export function htmlToDom(html, baseUrl, document) {
  const styleCSS = [];
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
    styleCSS.push(css);
    return '';
  });
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');

  const body = document.body;
  while (body.firstChild) body.removeChild(body.firstChild);

  const tokens = tokenize(html);
  const stack = [{ tag: '#root', node: body }];

  function current() { return stack[stack.length - 1].node; }

  function pushElement(tag, attrs) {
    const el = document.createElement(tag);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    current().appendChild(el);
    return el;
  }

  const VOID_TAGS = new Set([
    'area','base','br','col','embed','hr','img','input',
    'link','meta','param','source','track','wbr'
  ]);

  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];

    /* Inside a raw-content element, everything is text until its close. */
    const top = stack[stack.length - 1];
    if (top && top.rawContent) {
      if (tok.type === 'text') { top.rawText += tok.value; continue; }
      if (tok.type === 'open') {
        /* Preserve "<tag" literally, matching html-to-text's capture. */
        const attrStr = Object.entries(tok.attrs)
          .map(([k, v]) => v === '' ? ' ' + k : ` ${k}="${v}"`).join('');
        top.rawText += '<' + tok.tag + attrStr + (tok.selfClose ? '/' : '') + '>';
        continue;
      }
      if (tok.type === 'close' && tok.tag === top.tag) {
        const txt = document.createTextNode(top.rawText);
        top.node.appendChild(txt);
        stack.pop();
        continue;
      }
      /* Stray close inside raw-content — treat as literal text. */
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

  return { css: styleCSS };
}
