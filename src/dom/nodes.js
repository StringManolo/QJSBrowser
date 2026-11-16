/* Minimal DOM tree: Node, Text, Element, DocumentFragment, Document.
 *
 * Not spec-compliant. The target is "React and simple web code work".
 * Highlights:
 *   - Element and Document share the same querySelector logic.
 *   - style is a Proxy: el.style.color = 'red' works, kebab-cases camelCase.
 *   - classList stays in sync with the `class` attribute.
 *   - EventTarget bubbling goes up parentNode to the document.
 *   - innerHTML setter currently replaces content with text.
 *   - Every mutator notifies src/dom/mutation-hook.js so the active tab
 *     can be re-serialized on the next frame (dom-live-render).
 *   - isConnected gates notification so building a detached tree or a
 *     DocumentFragment doesn't spam the hook.
 *   - document.write is a no-op with a warning.
 *   - ownerDocument returns the document that created the node (or the
 *     current global document for nodes built via `new Element(...)`).
 */

import { EventTarget, Event } from 'src/dom/events.js';
import { notifyMutation, beginMutationBatch, endMutationBatch } from 'src/dom/mutation-hook.js';

const ELEMENT_NODE = 1;
const TEXT_NODE    = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

function kebabCase(s) {
  return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

function matchCompound(el, compound) {
  if (!el || el.nodeType !== ELEMENT_NODE) return false;
  const re = /([a-zA-Z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)/;
  const m = compound.match(re);
  if (!m) return false;
  const tag = m[1], id = m[2], classes = m[3], attrs = m[4];

  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if (id) {
    if (el.getAttribute('id') !== id.slice(1)) return false;
  }
  if (classes) {
    for (const c of classes.split('.').filter(Boolean)) {
      if (!el.classList.contains(c)) return false;
    }
  }
  if (attrs) {
    const attrRe = /\[([\w-]+)(?:=([^\]]+))?\]/g;
    let am;
    while ((am = attrRe.exec(attrs)) !== null) {
      const name = am[1];
      const val  = am[2];
      if (val === undefined) {
        if (!el.hasAttribute(name)) return false;
      } else {
        const stripped = val.replace(/^["']|["']$/g, '');
        if (el.getAttribute(name) !== stripped) return false;
      }
    }
  }
  return true;
}

function ancestorMatches(node, parts, idx) {
  let n = node;
  while (n && n.nodeType === ELEMENT_NODE) {
    if (matchCompound(n, parts[idx])) {
      if (idx === 0) return true;
      return ancestorMatches(n.parentNode, parts, idx - 1);
    }
    n = n.parentNode;
  }
  return false;
}

function queryFrom(root, selector) {
  const results = [];
  for (const compound of String(selector).split(',').map(s => s.trim()).filter(Boolean)) {
    const parts = compound.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const lastIdx = parts.length - 1;
    const last = parts[lastIdx];

    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== ELEMENT_NODE) continue;
        if (matchCompound(child, last)) {
          if (lastIdx === 0 || ancestorMatches(child.parentNode, parts, lastIdx - 1)) {
            results.push(child);
          }
        }
        walk(child);
      }
    };
    walk(root);
  }
  return results;
}

export class Node extends EventTarget {
  constructor() {
    super();
    this.parentNode = null;
    this.childNodes = [];
    this._ownerDocument = null;
  }

  get nodeType() { return 0; }
  get ownerDocument() {
    if (this.nodeType === DOCUMENT_NODE) return null;
    return this._ownerDocument || globalThis.document || null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild()  { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    const i = s.indexOf(this);
    return i >= 0 && i < s.length - 1 ? s[i + 1] : null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    const i = s.indexOf(this);
    return i > 0 ? s[i - 1] : null;
  }

  get isConnected() {
    let n = this;
    while (n) {
      if (n.nodeType === DOCUMENT_NODE) return true;
      n = n.parentNode;
    }
    return false;
  }

  appendChild(child) {
    if (!child) throw new TypeError('appendChild: node is required');
    if (child.nodeType === DOCUMENT_FRAGMENT_NODE) {
      beginMutationBatch();
      try {
        const kids = child.childNodes.slice();
        for (const k of kids) this.appendChild(k);
      } finally {
        endMutationBatch();
      }
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    if (this.isConnected) notifyMutation();
    return child;
  }

  insertBefore(child, ref) {
    if (!child) throw new TypeError('insertBefore: node is required');
    if (ref === null || ref === undefined) return this.appendChild(child);
    if (ref === child) return child;
    if (ref.parentNode !== this) throw new Error('insertBefore: ref is not a child');
    if (child.nodeType === DOCUMENT_FRAGMENT_NODE) {
      beginMutationBatch();
      try {
        const kids = child.childNodes.slice();
        for (const k of kids) this.insertBefore(k, ref);
      } finally {
        endMutationBatch();
      }
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const idx = this.childNodes.indexOf(ref);
    this.childNodes.splice(idx, 0, child);
    if (this.isConnected) notifyMutation();
    return child;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx < 0) throw new Error('removeChild: node is not a child');
    this.childNodes.splice(idx, 1);
    child.parentNode = null;
    if (this.isConnected) notifyMutation();
    return child;
  }

  replaceChild(newChild, oldChild) {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx < 0) throw new Error('replaceChild: node is not a child');
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    this.childNodes[idx] = newChild;
    newChild.parentNode = this;
    oldChild.parentNode = null;
    if (this.isConnected) notifyMutation();
    return oldChild;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  hasChildNodes() { return this.childNodes.length > 0; }

  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }

  get textContent() {
    let out = '';
    for (const c of this.childNodes) out += c.textContent || '';
    return out;
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== null && v !== undefined && String(v).length > 0) {
      const t = new Text(String(v));
      t._ownerDocument = this.ownerDocument;
      this.appendChild(t);
    } else if (this.isConnected) {
      notifyMutation();
    }
  }

  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const t = new Text(n);
        t._ownerDocument = this.ownerDocument;
        this.appendChild(t);
      } else if (n) this.appendChild(n);
    }
  }
  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) {
      if (typeof n === 'string') {
        const t = new Text(n);
        t._ownerDocument = this.ownerDocument;
        this.insertBefore(t, first);
      } else if (n) this.insertBefore(n, first);
    }
  }

  _query(selector, first) {
    const found = queryFrom(this, selector);
    return first ? (found[0] || null) : found;
  }
}

export class Text extends Node {
  constructor(data) {
    super();
    this._data = String(data == null ? '' : data);
  }
  get nodeType() { return TEXT_NODE; }
  get nodeName() { return '#text'; }
  get nodeValue() { return this._data; }
  set nodeValue(v) { this._data = String(v == null ? '' : v); if (this.isConnected) notifyMutation(); }
  get data() { return this._data; }
  set data(v) { this._data = String(v == null ? '' : v); if (this.isConnected) notifyMutation(); }
  get textContent() { return this._data; }
  set textContent(v) { this._data = String(v == null ? '' : v); if (this.isConnected) notifyMutation(); }
  get length() { return this._data.length; }
}

export class Comment extends Node {
  constructor(data) {
    super();
    this._data = String(data == null ? '' : data);
  }
  get nodeType() { return COMMENT_NODE; }
  get nodeName() { return '#comment'; }
  get nodeValue() { return this._data; }
  set nodeValue(v) { this._data = String(v == null ? '' : v); }
  get data() { return this._data; }
  set data(v) { this._data = String(v == null ? '' : v); }
  get textContent() { return this._data; }
  set textContent(v) { this._data = String(v == null ? '' : v); }
}

class ClassList {
  constructor(element) { this._el = element; }
  _parts() { return (this._el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _write(parts) { this._el.setAttribute('class', parts.join(' ')); }
  add(...names) {
    const set = new Set(this._parts());
    for (const n of names) if (n) set.add(String(n));
    this._write([...set]);
  }
  remove(...names) {
    const set = new Set(this._parts());
    for (const n of names) set.delete(String(n));
    this._write([...set]);
  }
  contains(n) { return this._parts().includes(String(n)); }
  toggle(n, force) {
    n = String(n);
    const has = this.contains(n);
    if (force === true  && !has) { this.add(n);    return true; }
    if (force === false && has)  { this.remove(n); return false; }
    if (has) { this.remove(n); return false; }
    this.add(n); return true;
  }
  replace(a, b) {
    const parts = this._parts();
    const i = parts.indexOf(String(a));
    if (i < 0) return false;
    parts[i] = String(b);
    this._write(parts);
    return true;
  }
  get length() { return this._parts().length; }
  item(i) { return this._parts()[i] || null; }
  toString() { return this._parts().join(' '); }
  forEach(fn, thisArg) { this._parts().forEach(fn, thisArg); }
  [Symbol.iterator]() { return this._parts()[Symbol.iterator](); }
}

class Style {
  constructor(element) {
    this._el = element;
    return new Proxy(this, {
      set(target, prop, value) {
        if (typeof prop === 'symbol') { target[prop] = value; return true; }
        if (prop === '_el') { target._el = value; return true; }
        if (prop === 'cssText') { target._setAll(String(value)); return true; }
        target._set(kebabCase(String(prop)), String(value));
        return true;
      },
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop];
        if (prop === '_el') return target._el;
        if (prop === 'cssText')          return target._getAll();
        if (prop === 'setProperty')      return (k, v) => target._set(String(k), String(v));
        if (prop === 'getPropertyValue') return (k) => target._get(String(k));
        if (prop === 'removeProperty')   return (k) => target._remove(String(k));
        if (prop === 'length')           return target._entries().length;
        if (prop === 'item')             return (i) => target._entries()[i] ? target._entries()[i][0] : '';
        return target._get(kebabCase(String(prop)));
      },
    });
  }
  _entries() {
    const s = this._el.getAttribute('style') || '';
    return s.split(';').map(x => x.trim()).filter(Boolean).map(x => {
      const i = x.indexOf(':');
      if (i < 0) return ['', ''];
      return [x.slice(0, i).trim(), x.slice(i + 1).trim()];
    });
  }
  _get(k) {
    const e = this._entries().find(([n]) => n === k);
    return e ? e[1] : '';
  }
  _set(k, v) {
    const e = this._entries().filter(([n]) => n !== k);
    if (v !== '') e.push([k, v]);
    this._el.setAttribute('style', e.map(([n, val]) => n + ': ' + val).join('; '));
  }
  _remove(k) {
    const e = this._entries().filter(([n]) => n !== k);
    this._el.setAttribute('style', e.map(([n, val]) => n + ': ' + val).join('; '));
  }
  _getAll() {
    return this._entries().map(([n, v]) => n + ': ' + v).join('; ');
  }
  _setAll(text) {
    const entries = String(text).split(';').map(x => x.trim()).filter(Boolean).map(x => {
      const i = x.indexOf(':');
      return i < 0 ? null : [x.slice(0, i).trim(), x.slice(i + 1).trim()];
    }).filter(Boolean);
    this._el.setAttribute('style', entries.map(([n, v]) => n + ': ' + v).join('; '));
  }
}

export class Element extends Node {
  constructor(tagName, namespaceURI) {
    super();
    this.namespaceURI = namespaceURI || 'http://www.w3.org/1999/xhtml';
    const isHtml = this.namespaceURI.includes('xhtml');
    this.tagName   = isHtml ? String(tagName).toUpperCase() : String(tagName);
    this.localName = isHtml ? String(tagName).toLowerCase() : String(tagName);
    this.attributes = Object.create(null);
    this.style      = new Style(this);
    this.classList  = new ClassList(this);
    this.dataset    = {};
  }
  get nodeType() { return ELEMENT_NODE; }
  get nodeName() { return this.tagName; }

  setAttribute(name, value) {
    this.attributes[String(name).toLowerCase()] = String(value);
    if (this.isConnected) notifyMutation();
  }
  getAttribute(name)    { const v = this.attributes[String(name).toLowerCase()]; return v === undefined ? null : v; }
  removeAttribute(name) {
    delete this.attributes[String(name).toLowerCase()];
    if (this.isConnected) notifyMutation();
  }
  hasAttribute(name)    { return String(name).toLowerCase() in this.attributes; }
  getAttributeNames()   { return Object.keys(this.attributes); }

  get id()        { return this.getAttribute('id') || ''; }
  set id(v)       { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }

  get children() { return this.childNodes.filter(c => c.nodeType === ELEMENT_NODE); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() {
    const c = this.children;
    return c[c.length - 1] || null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }
  get nextElementSibling() {
    const n = this.nextSibling;
    return n && n.nodeType === ELEMENT_NODE ? n : null;
  }
  get previousElementSibling() {
    const n = this.previousSibling;
    return n && n.nodeType === ELEMENT_NODE ? n : null;
  }

  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) { this.textContent = String(html == null ? '' : html); }
  get outerHTML() { return serialize(this); }

  querySelector(sel)    { return this._query(sel, true); }
  querySelectorAll(sel)  { return this._query(sel, false); }
  matches(sel)           { return matchCompound(this, String(sel).trim()); }

  closest(sel) {
    let n = this;
    while (n && n.nodeType === ELEMENT_NODE) {
      if (matchCompound(n, String(sel).trim())) return n;
      n = n.parentNode;
    }
    return null;
  }

  click() { this.dispatchEvent(new Event('click', { bubbles: true })); }

  getBoundingClientRect() {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  focus() {}
  blur()  {}
}

export const HTMLElement = Element;

export class DocumentFragment extends Node {
  constructor() { super(); }
  get nodeType() { return DOCUMENT_FRAGMENT_NODE; }
  get nodeName() { return '#document-fragment'; }
}

export class Document extends Node {
  constructor() {
    super();
    this.documentElement = new Element('html');
    this.head = new Element('head');
    this.body = new Element('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.readyState = 'complete';
  }
  get nodeType() { return DOCUMENT_NODE; }
  get nodeName() { return '#document'; }
  get defaultView() { return globalThis; }
  get activeElement() { return this.body; }
  get visibilityState() { return 'visible'; }
  hasFocus() { return true; }

  createElement(tag) {
    const el = new Element(tag);
    el._ownerDocument = this;
    return el;
  }
  createElementNS(ns, tag) {
    const el = new Element(tag, ns);
    el._ownerDocument = this;
    return el;
  }
  createTextNode(data) {
    const t = new Text(data);
    t._ownerDocument = this;
    return t;
  }
  createComment(data) {
    const c = new Comment(data);
    c._ownerDocument = this;
    return c;
  }
  createDocumentFragment() {
    const f = new DocumentFragment();
    f._ownerDocument = this;
    return f;
  }
  createEvent(type) { return new Event(String(type)); }

  write(..._args) {
    console.warn('[document.write] not supported — ignored');
  }
  writeln(..._args) {
    console.warn('[document.writeln] not supported — ignored');
  }

  getElementById(id) {
    const want = String(id);
    let found = null;
    const walk = (n) => {
      if (found) return;
      for (const c of n.childNodes) {
        if (c.nodeType === ELEMENT_NODE) {
          if (c.getAttribute('id') === want) { found = c; return; }
          walk(c);
          if (found) return;
        }
      }
    };
    walk(this);
    return found;
  }
  querySelector(sel)   { return this._query(sel, true); }
  querySelectorAll(sel) { return this._query(sel, false); }

  get title() {
    const t = this.querySelector('title');
    return t ? t.textContent : '';
  }
  set title(v) {
    let t = this.querySelector('title');
    if (!t) { t = this.createElement('title'); this.head.appendChild(t); }
    t.textContent = String(v);
  }

  get URL()      { return (globalThis.location && globalThis.location.href) || 'about:blank'; }
  get location() { return globalThis.location; }
}

function serialize(node) {
  if (node.nodeType === TEXT_NODE) {
    return String(node.data)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (node.nodeType === COMMENT_NODE) {
    return '<!--' + String(node.data) + '-->';
  }
  if (node.nodeType !== ELEMENT_NODE) return '';
  const tag = node.localName;
  const attrs = Object.entries(node.attributes)
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
  return `<${tag}${attrs}>${node.childNodes.map(serialize).join('')}</${tag}>`;
}
