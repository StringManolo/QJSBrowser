/* Minimal DOM event model: Event, CustomEvent, EventTarget.
 *
 * Supports bubbling (target → document) and capture (document → target).
 * No capture-phase-only tricks, no passive-mode enforcement, no
 * relatedTarget — just what React + jQuery-style libs reach for.
 *
 * ev._handled is set to true the first time a listener runs. Used by the
 * controller to decide whether to fall back to native behavior after
 * dispatching a synthetic click (e.g. form submit if React didn't take
 * over). */

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
    this._handled = false;
    if (init.clientX !== undefined) this.clientX = init.clientX;
    if (init.clientY !== undefined) this.clientY = init.clientY;
    if (init.key !== undefined) this.key = init.key;
    if (init.button !== undefined) this.button = init.button;
  }
  stopPropagation() { this._stopPropagation = true; }
  stopImmediatePropagation() {
    this._stopPropagation = true;
    this._stopImmediate = true;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  /* Legacy DOM Level 2 API. React dev mode's guarded-callback wrapper
   * creates an Event, calls evt.initEvent(...), then dispatches it to test
   * if the native dispatch path works. Without this method, the dev build
   * throws "initEvent is not a function" from inside executeDispatch. */
  initEvent(type, bubbles, cancelable) {
    this.type = String(type);
    this.bubbles = bubbles === true;
    this.cancelable = cancelable === true;
  }
}

export class CustomEvent extends Event {
  constructor(type, init) {
    super(type, init);
    this.detail = init && init.detail !== undefined ? init.detail : null;
  }
  initCustomEvent(type, bubbles, cancelable, detail) {
    this.initEvent(type, bubbles, cancelable);
    this.detail = detail !== undefined ? detail : null;
  }
}


export class EventTarget {
  constructor() { this._listeners = new Map(); }

  addEventListener(type, listener, options) {
    if (!listener) return;
    type = String(type);
    let once = false;
    let capture = false;
    if (options === true) capture = true;
    else if (options && typeof options === 'object') {
      once    = !!options.once;
      capture = !!options.capture;
    }
    let list = this._listeners.get(type);
    if (!list) { list = []; this._listeners.set(type, list); }
    for (const e of list) {
      if (e.listener === listener && e.capture === capture) return;
    }
    list.push({ listener, once, capture });
  }

  removeEventListener(type, listener, options) {
    type = String(type);
    let capture = false;
    if (options === true) capture = true;
    else if (options && typeof options === 'object') capture = !!options.capture;
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

    ev._handled = false;

    const path = [];
    let n = this;
    while (n) { path.push(n); n = n.parentNode || null; }
    if (!ev.bubbles) path.length = 1;

    if (ev.target === null) ev.target = this;

    for (let i = path.length - 1; i >= 0; i--) {
      ev.currentTarget = path[i];
      _fire(path[i], ev, true);
      if (ev._stopPropagation) return !ev.defaultPrevented;
    }
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
  const snapshot = list.slice();
  for (const entry of snapshot) {
    if (entry.capture !== capturePhase) continue;
    if (entry.once) {
      const idx = list.indexOf(entry);
      if (idx >= 0) list.splice(idx, 1);
    }
    ev._handled = true;
    try {
      if (typeof entry.listener === 'function') entry.listener.call(target, ev);
      else if (entry.listener && typeof entry.listener.handleEvent === 'function')
        entry.listener.handleEvent(ev);
    } catch (e) {
      /* Log message + stack. Without the stack, "cannot read property 'tag'
       * of null" is unattributable — it could be any of React's event
       * plugins (SelectEventPlugin, ChangeEventPlugin, …) that inspect the
       * fiber on the target path. */
      const msg = e && e.message ? e.message : String(e);
      const st  = e && e.stack ? String(e.stack) : '';
      console.error('[event] ' + msg + (st ? '\n' + st : ''));
    }
    if (ev._stopImmediate) return;
  }
}
