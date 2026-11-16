/* Installs DOM globals: document + constructors (Node, Element, …) and a
 * minimal EventTarget view over globalThis (window.addEventListener /
 * dispatchEvent / onload). Idempotent. */

import { Event, CustomEvent, EventTarget } from 'src/dom/events.js';
import {
  Node, Text, Element, Document, DocumentFragment,
} from 'src/dom/nodes.js';

let _document = null;

export function getDocument() {
  if (!_document) _document = new Document();
  return _document;
}

export function resetDocument() {
  _document = new Document();
  _document.readyState = 'loading';
  globalThis.document = _document;
  return _document;
}

export function setReadyState(state) {
  if (_document) _document.readyState = state;
}

export function installDomGlobals() {
  const g = globalThis;

  if (!g.Node)             g.Node             = Node;
  if (!g.Element)          g.Element          = Element;
  if (!g.HTMLElement)      g.HTMLElement      = Element;
  if (!g.Text)             g.Text             = Text;
  if (!g.Document)         g.Document         = Document;
  if (!g.DocumentFragment) g.DocumentFragment = DocumentFragment;
  if (!g.Event)            g.Event            = Event;
  if (!g.CustomEvent)      g.CustomEvent      = CustomEvent;
  if (!g.EventTarget)      g.EventTarget      = EventTarget;

  if (!g.document) _document = new Document();
  else _document = g.document;

  g.document = _document;

  /* Window as EventTarget: needed for load event and some libs. We can't
   * change globalThis's prototype, so delegate to a dedicated instance. */
  if (!g.addEventListener) {
    const winET = new EventTarget();
    g.addEventListener    = (t, fn, o) => winET.addEventListener(t, fn, o);
    g.removeEventListener = (t, fn, o) => winET.removeEventListener(t, fn, o);
    g.dispatchEvent       = (ev)      => winET.dispatchEvent(ev);

    let onloadFn = null;
    Object.defineProperty(g, 'onload', {
      configurable: true,
      get: () => onloadFn,
      set: (fn) => {
        if (onloadFn) winET.removeEventListener('load', onloadFn);
        onloadFn = fn;
        if (fn) winET.addEventListener('load', fn);
      },
    });
  }

  return _document;
}
