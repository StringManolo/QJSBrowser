export function createHistory() {
  const entries = [];
  let index = -1;

  function push(url) {
    entries.length = index + 1;
    if (entries[entries.length - 1] === url) return false;
    entries.push(url);
    index = entries.length - 1;
    return true;
  }

  function replace(url) {
    if (index >= 0) entries[index] = url;
    else push(url);
  }

  function back() {
    if (index <= 0) return null;
    index--;
    return entries[index];
  }

  function forward() {
    if (index >= entries.length - 1) return null;
    index++;
    return entries[index];
  }

  /* Wipe the entire stack. Leaves index = -1 so the next push() starts
   * a fresh list — matches "clear browsing data" semantics: current
   * page stays loaded, but canBack()/canForward() go false and the
   * back/forward buttons disable. */
  function clear() {
    entries.length = 0;
    index = -1;
  }

  return {
    push, replace, back, forward, clear,
    canBack:    () => index > 0,
    canForward: () => index < entries.length - 1,
    get current() { return entries[index] || ''; },
    get length()  { return entries.length; },
  };
}
