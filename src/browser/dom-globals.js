import { Event, CustomEvent, EventTarget } from 'src/dom/events.js';
import {
  Node, Text, Element, Document, DocumentFragment, Comment,
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

/* --- Class factories ------------------------------------------------ *
 *
 * React (and most modern libs) do `x instanceof Foo` as guards for
 * element types, event types, node types, collections. In a real browser
 * all of these classes exist. Here we synthesize them so `instanceof`
 * never throws "invalid 'instanceof' right operand" (which happens when
 * Foo is undefined). Each class uses Symbol.hasInstance to answer
 * correctly: `createElement('div') instanceof HTMLDivElement` is true,
 * `createElement('div') instanceof HTMLSpanElement` is false.
 */

function makeElementClass(tag) {
  function C() {}
  Object.defineProperty(C, Symbol.hasInstance, {
    value: (inst) =>
      inst instanceof Element &&
      inst.localName === tag &&
      inst.namespaceURI === 'http://www.w3.org/1999/xhtml',
  });
  return C;
}

function makeTagSetClass(tags) {
  function C() {}
  Object.defineProperty(C, Symbol.hasInstance, {
    value: (inst) =>
      inst instanceof Element &&
      inst.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      tags.indexOf(inst.localName) !== -1,
  });
  return C;
}

function makeNamespaceClass(ns) {
  function C() {}
  Object.defineProperty(C, Symbol.hasInstance, {
    value: (inst) => inst instanceof Element && inst.namespaceURI === ns,
  });
  return C;
}

function makeStubClass() {
  function C() { throw new Error('not implemented'); }
  Object.defineProperty(C, Symbol.hasInstance, { value: () => false });
  return C;
}

function makeEventClass() {
  function C() {}
  Object.defineProperty(C, Symbol.hasInstance, {
    value: (inst) => inst instanceof Event && inst._isSyntheticOf === C,
  });
  return C;
}

function NodeList() {}
Object.defineProperty(NodeList, Symbol.hasInstance, { value: Array.isArray });

function HTMLCollection() {}
Object.defineProperty(HTMLCollection, Symbol.hasInstance, { value: Array.isArray });

function DOMTokenList() {}
Object.defineProperty(DOMTokenList, Symbol.hasInstance, {
  value: (inst) => inst && typeof inst === 'object' &&
                   typeof inst.contains === 'function' &&
                   typeof inst.add === 'function',
});

/* The browser's class name for a tag is NOT always 'HTML' + CapitalizedTag
 * + 'Element'. These are the known deviations:
 *   iframe   → HTMLIFrameElement       (IF, not If)
 *   img      → HTMLImageElement        (Image, not Img)
 *   optgroup → HTMLOptGroupElement     (G capital)
 *   colgroup → HTMLTableColElement     (TableCol, not Colgroup)
 *   bdi      → HTMLBDIElement          (BDI all caps)
 *   bdo      → HTMLBDOElement          (BDO all caps)
 *   menuitem → HTMLMenuItemElement     (I capital)
 * React (specifically) checks instanceof HTMLIFrameElement, so getting
 * this wrong is a hard crash — not just a cosmetic mismatch. */
const HTML_CLASS_NAME_OVERRIDES = {
  iframe:   'IFrame',
  img:      'Image',
  optgroup: 'OptGroup',
  colgroup: 'TableCol',
  bdi:      'BDI',
  bdo:      'BDO',
  menuitem: 'MenuItem',
};

const HTML_TAG_CLASSES = [
  'a','abbr','address','area','article','aside','audio','b','base',
  'bdi','bdo','blockquote','body','br','button','canvas','caption',
  'cite','code','col','colgroup','data','datalist','dd','del','details',
  'dfn','dialog','div','dl','dt','em','embed','fieldset','figcaption',
  'figure','footer','form','h1','h2','h3','h4','h5','h6','head','header',
  'hgroup','hr','html','i','iframe','img','input','ins','kbd','label',
  'legend','li','link','main','map','mark','menu','meta','meter','nav',
  'noscript','object','ol','optgroup','option','output','p','param',
  'picture','pre','progress','q','rp','rt','ruby','s','samp','script',
  'search','section','select','slot','small','source','span','strong',
  'style','sub','summary','sup','table','tbody','td','template','textarea',
  'tfoot','th','thead','time','title','tr','track','u','ul','var','video',
  'wbr','menuitem',
];

function classNameFor(tag) {
  const override = HTML_CLASS_NAME_OVERRIDES[tag];
  if (override) return 'HTML' + override + 'Element';
  return 'HTML' + tag.charAt(0).toUpperCase() + tag.slice(1) + 'Element';
}

function installElementClasses(g) {
  for (const tag of HTML_TAG_CLASSES) {
    const name = classNameFor(tag);
    if (!g[name]) g[name] = makeElementClass(tag);
  }

  if (!g.HTMLUnknownElement) g.HTMLUnknownElement = makeElementClass('__unknown__');
  if (!g.HTMLMediaElement)   g.HTMLMediaElement   = makeTagSetClass(['video', 'audio']);
  if (!g.SVGElement)         g.SVGElement         = makeNamespaceClass('http://www.w3.org/2000/svg');
  if (!g.SVGSVGElement)      g.SVGSVGElement      = makeNamespaceClass('http://www.w3.org/2000/svg');
  if (!g.SVGGraphicsElement) g.SVGGraphicsElement = makeNamespaceClass('http://www.w3.org/2000/svg');

  /* CharacterData is the DOM base class of Text and Comment. React
   * sometimes tests `node instanceof CharacterData`. */
  if (!g.CharacterData) {
    function CharacterData() {}
    Object.defineProperty(CharacterData, Symbol.hasInstance, {
      value: (inst) => inst instanceof Node && (inst.nodeType === 3 || inst.nodeType === 8),
    });
    g.CharacterData = CharacterData;
  }

  if (!g.NodeList)       g.NodeList       = NodeList;
  if (!g.HTMLCollection) g.HTMLCollection = HTMLCollection;
  if (!g.DOMTokenList)   g.DOMTokenList   = DOMTokenList;
  if (!g.HTMLDocument)   g.HTMLDocument   = Document;
  if (!g.XMLDocument)    g.XMLDocument    = makeStubClass();
  if (!g.ShadowRoot)     g.ShadowRoot     = makeStubClass();
  if (!g.DocumentType)   g.DocumentType   = makeStubClass();
  if (!g.ProcessingInstruction) g.ProcessingInstruction = makeStubClass();
  if (!g.CDATASection)   g.CDATASection   = makeStubClass();
  if (!g.Attr)           g.Attr           = makeStubClass();
  if (!g.NamedNodeMap)   g.NamedNodeMap   = makeStubClass();
  if (!g.CSSStyleDeclaration) g.CSSStyleDeclaration = makeStubClass();
  if (!g.DOMRect)        g.DOMRect        = makeStubClass();
  if (!g.DOMRectReadOnly) g.DOMRectReadOnly = makeStubClass();
  if (!g.Range)          g.Range          = makeStubClass();
  if (!g.Selection)      g.Selection      = makeStubClass();
  if (!g.Window)         g.Window         = makeStubClass();
  if (!g.CustomElementRegistry) g.CustomElementRegistry = makeStubClass();

  /* Event subclasses — React's event system does instanceof checks on
   * nativeEvent against these classes. We never construct them here, so
   * hasInstance returns false for all our events (safe), but the classes
   * being defined prevents "invalid instanceof" throws. */
  const EVENT_CLASSES = [
    'UIEvent','MouseEvent','KeyboardEvent','PointerEvent','TouchEvent',
    'WheelEvent','InputEvent','FocusEvent','DragEvent','AnimationEvent',
    'TransitionEvent','CompositionEvent','MessageEvent','ErrorEvent',
    'ProgressEvent','PopStateEvent','HashChangeEvent','StorageEvent',
    'BeforeUnloadEvent','ClipboardEvent',
  ];
  for (const name of EVENT_CLASSES) {
    if (!g[name]) g[name] = makeEventClass();
  }

  if (!g.MutationObserver) {
    function MutationObserver() { this._cb = null; }
    MutationObserver.prototype.observe = function() {};
    MutationObserver.prototype.disconnect = function() {};
    MutationObserver.prototype.takeRecords = function() { return []; };
    Object.defineProperty(MutationObserver, Symbol.hasInstance, {
      value: (inst) => inst && typeof inst.observe === 'function',
    });
    g.MutationObserver = MutationObserver;
  }
  if (!g.IntersectionObserver) g.IntersectionObserver = makeStubClass();
  if (!g.ResizeObserver)       g.ResizeObserver       = makeStubClass();
  if (!g.PerformanceObserver)  g.PerformanceObserver  = makeStubClass();
}

export function installDomGlobals() {
  const g = globalThis;

  if (!g.Node)             g.Node             = Node;
  if (!g.Element)          g.Element          = Element;
  if (!g.HTMLElement)      g.HTMLElement      = Element;
  if (!g.Text)             g.Text             = Text;
  if (!g.Comment)          g.Comment          = Comment;
  if (!g.Document)         g.Document         = Document;
  if (!g.DocumentFragment) g.DocumentFragment = DocumentFragment;
  if (!g.Event)            g.Event            = Event;
  if (!g.CustomEvent)      g.CustomEvent      = CustomEvent;
  if (!g.EventTarget)      g.EventTarget      = EventTarget;

  installElementClasses(g);

  if (!g.document) _document = new Document();
  else _document = g.document;

  g.document = _document;

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
