let nextId = 1;

export function createFormState() {
  const elements = new Map();
  const order = [];
  const forms = new Map();
  let focusedId = null;
  let cursor = 0;

  function reset() {
    elements.clear();
    order.length = 0;
    forms.clear();
    focusedId = null;
    cursor = 0;
    nextId = 1;
  }

  function newForm(action, method) {
    const id = 'f' + (forms.size + 1);
    forms.set(id, { id, action, method: (method || 'GET').toUpperCase() });
    return id;
  }

  function addElement(info) {
    const id = 'e' + (nextId++);
    elements.set(id, { ...info, id, value: info.value || '', checked: !!info.checked });
    order.push(id);
    return id;
  }

  function get(id) { return elements.get(id) || null; }
  function getFocused() { return focusedId ? elements.get(focusedId) : null; }
  function focusedIdOf() { return focusedId; }
  function cursorPos() { return cursor; }

  function focus(id) {
    if (!elements.has(id)) return;
    focusedId = id;
    cursor = (elements.get(id).value || '').length;
  }

  function blur() { focusedId = null; cursor = 0; }

  function isEditable(el) {
    return el && (el.kind === 'text' || el.kind === 'password') &&
           !el.disabled && !el.readonly;
  }

  function type(ch) {
    const el = getFocused();
    if (!isEditable(el)) return false;
    el.value = el.value.slice(0, cursor) + ch + el.value.slice(cursor);
    cursor++;
    return true;
  }

  function backspace() {
    const el = getFocused();
    if (!isEditable(el)) return false;
    if (cursor === 0) return false;
    el.value = el.value.slice(0, cursor - 1) + el.value.slice(cursor);
    cursor--;
    return true;
  }

  function del() {
    const el = getFocused();
    if (!isEditable(el)) return false;
    if (cursor >= el.value.length) return false;
    el.value = el.value.slice(0, cursor) + el.value.slice(cursor + 1);
    return true;
  }

  function moveCursor(delta) {
    const el = getFocused();
    if (!isEditable(el)) return;
    cursor = Math.max(0, Math.min(el.value.length, cursor + delta));
  }

  function moveCursorTo(pos) {
    const el = getFocused();
    if (!isEditable(el)) return;
    cursor = Math.max(0, Math.min(el.value.length, pos));
  }

  function toggle(id) {
    const el = elements.get(id);
    if (!el || el.disabled) return false;
    if (el.kind === 'checkbox') { el.checked = !el.checked; return true; }
    if (el.kind === 'radio') {
      for (const other of elements.values()) {
        if (other.kind === 'radio' && other.name === el.name && other.formId === el.formId) {
          other.checked = false;
        }
      }
      el.checked = true;
      return true;
    }
    return false;
  }

  function focusableInOrder() {
    return order.filter(id => {
      const el = elements.get(id);
      return el && !el.disabled && (el.kind === 'text' || el.kind === 'password' ||
             el.kind === 'checkbox' || el.kind === 'radio' ||
             el.kind === 'submit' || el.kind === 'button' || el.kind === 'reset');
    });
  }

  function tabNext(dir) {
    const list = focusableInOrder();
    if (list.length === 0) return null;
    if (!focusedId) return list[0];
    const idx = list.indexOf(focusedId);
    if (idx < 0) return list[0];
    const next = idx + dir;
    if (next < 0) return list[list.length - 1];
    if (next >= list.length) return list[0];
    return list[next];
  }

  function findForm(elementId) {
    const el = elements.get(elementId);
    if (!el || !el.formId) return null;
    return forms.get(el.formId) || null;
  }

  function collect(formId) {
    const form = forms.get(formId);
    if (!form) return null;
    const pairs = [];
    for (const id of order) {
      const el = elements.get(id);
      if (!el || el.formId !== formId || !el.name || el.disabled) continue;
      if (el.kind === 'text')          pairs.push([el.name, el.value]);
      else if (el.kind === 'password') pairs.push([el.name, el.value]);
      else if (el.kind === 'checkbox' && el.checked) pairs.push([el.name, el.value || 'on']);
      else if (el.kind === 'radio'    && el.checked) pairs.push([el.name, el.value || 'on']);
      else if (el.kind === 'select'   && el.selectedValue !== undefined)
        pairs.push([el.name, el.selectedValue]);
      else if (el.kind === 'textarea') pairs.push([el.name, el.value]);
    }
    const data = pairs.map(([k, v]) =>
      encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    return { action: form.action, method: form.method, data };
  }

  return {
    reset, newForm, addElement, get, getFocused, focusedIdOf, cursorPos,
    focus, blur, type, backspace, del, moveCursor, moveCursorTo,
    toggle, tabNext, findForm, collect,
    elements, order, forms,
  };
}
