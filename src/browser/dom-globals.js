/* Installs DOM globals: document + constructors (Node, Element, …).
 * Idempotent. One document lives at a time; resetDocument() swaps it,
 * which is what the parser PR will call on each navigation. */

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
  globalThis.document = _document;
  return _document;
}

export function installDomGlobals() {
  const g = globalThis;

  /* Constructors — needed for `instanceof HTMLElement`, `new Event(…)`, … */
  if (!g.Node)             g.Node             = Node;
  if (!g.Element)          g.Element          = Element;
  if (!g.HTMLElement)      g.HTMLElement      = Element;   /* same class */
  if (!g.Text)             g.Text             = Text;
  if (!g.Document)         g.Document         = Document;
  if (!g.DocumentFragment) g.DocumentFragment = DocumentFragment;
  if (!g.Event)            g.Event            = Event;
  if (!g.CustomEvent)      g.CustomEvent      = CustomEvent;
  if (!g.EventTarget)      g.EventTarget      = EventTarget;

  if (!g.document) _document = new Document();
  else _document = g.document;

  g.document = _document;
  return _document;
}
