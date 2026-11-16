/* Minimal DOM event model: Event, CustomEvent, EventTarget.
 *
 * Supports bubbling (target → document) and capture (document → target).
 * No capture-phase-only tricks, no passive-mode enforcement, no
 * relatedTarget — just what React + jQuery-style libs reach for. */

export class Event {
  constructor(type, init) {
    init = init || {};
    this.type = String(type);
    this.bubbles = init.bubbles === true;
    this.cancelable = init.cancelable === true;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._stopPropagation = false;
    this._stopImmediate = false;
  }
  stopPropagation() { this._stopPropagation = true; }
  stopImmediatePropagation() {
    this._stopPropagation = true;
    this._stopImmediate = true;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

export class CustomEvent extends Event {
  constructor(type, init) {
    super(type, init);
    this.detail = init && init.detail !== undefined ? init.detail : null;
  }
}

export class EventTarget {
  constructor() { this._listeners = new Map(); }

  addEventListener(type, listener, options) {
    if (!listener) return;
    type = String(type);
    const once    = options && typeof options === 'object' ? !!options.once    : false;
    const capture = options && typeof options === 'object' ? !!options.capture : false;
    let list = this._listeners.get(type);
    if (!list) { list = []; this._listeners.set(type, list); }
    for (const e of list) {
      if (e.listener === listener && e.capture === capture) return;
    }
    list.push({ listener, once, capture });
  }

  removeEventListener(type, listener, options) {
    type = String(type);
    const capture = options && typeof options === 'object' ? !!options.capture : false;
    const list = this._listeners.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      if (list[i].listener === listener && list[i].capture === capture) {
        list.splice(i, 1);
        return;
      }
    }
  }

  dispatchEvent(ev) {
    if (!ev || typeof ev !== 'object') return true;

    /* Build the propagation path: this → … → document */
    const path = [];
    let n = this;
    while (n) { path.push(n); n = n.parentNode || null; }
    if (!ev.bubbles) path.length = 1;

    if (ev.target === null) ev.target = this;

    /* Capture phase: outermost → innermost */
    for (let i = path.length - 1; i >= 0; i--) {
      ev.currentTarget = path[i];
      _fire(path[i], ev, true);
      if (ev._stopPropagation) return !ev.defaultPrevented;
    }
    /* Target + bubble phase: innermost → outermost */
    for (let i = 0; i < path.length; i++) {
      ev.currentTarget = path[i];
      _fire(path[i], ev, false);
      if (ev._stopPropagation) break;
    }
    return !ev.defaultPrevented;
  }
}

function _fire(target, ev, capturePhase) {
  const list = target._listeners && target._listeners.get(ev.type);
  if (!list) return;
  /* Snapshot: a listener that removes another during dispatch must not
   * skip the remaining entries. */
  const snapshot = list.slice();
  for (const entry of snapshot) {
    if (entry.capture !== capturePhase) continue;
    if (entry.once) {
      const idx = list.indexOf(entry);
      if (idx >= 0) list.splice(idx, 1);
    }
    try {
      if (typeof entry.listener === 'function') entry.listener.call(target, ev);
      else if (entry.listener && typeof entry.listener.handleEvent === 'function')
        entry.listener.handleEvent(ev);
    } catch (e) {
      console.error('[event] ' + (e && e.message ? e.message : String(e)));
    }
    if (ev._stopImmediate) return;
  }
}
