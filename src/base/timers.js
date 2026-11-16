/* Browser-compatible timers wired into the JS event loop.
 *
 * The loop calls nextDue() to shrink its epoll_wait timeout and runDue()
 * after each epoll batch. Caps prevent a setTimeout(fn, 0) feedback loop
 * (or a 60fps rAF loop) from starving input, rendering and network I/O. */

export function createTimers() {
  let nextId = 1;
  const timers = new Map();   /* id -> { id, due, interval, fn, args } */

  function schedule(fn, ms, interval, args) {
    const id = nextId++;
    const t = {
      id,
      due: Date.now() + Math.max(0, (ms | 0)),
      interval,
      fn,
      args,
    };
    timers.set(id, t);
    return id;
  }

  function clear(id) { timers.delete(id); }

  function nextDue() {
    if (timers.size === 0) return Infinity;
    let min = Infinity;
    for (const t of timers.values()) if (t.due < min) min = t.due;
    return min;
  }

  function runDue(now, cap) {
    if (timers.size === 0) return 0;
    cap = cap || 50;
    const due = [];
    for (const t of timers.values()) if (t.due <= now) due.push(t);
    if (due.length === 0) return 0;
    due.sort((a, b) => a.due - b.due);

    let ran = 0;
    for (const t of due) {
      if (ran >= cap) break;
      if (!timers.has(t.id)) continue;   /* cleared from another timer */
      if (t.interval !== null) t.due = now + t.interval;
      else timers.delete(t.id);
      try { t.fn.apply(null, t.args); }
      catch (e) { console.error('[timer] ' + (e && e.message ? e.message : String(e))); }
      ran++;
    }
    return ran;
  }

  return {
    setTimeout:    (fn, ms, ...args) => schedule(fn, ms, null, args),
    setInterval:   (fn, ms, ...args) => schedule(fn, ms, Math.max(1, (ms | 0) || 1), args),
    clearTimeout:  clear,
    clearInterval: clear,
    nextDue,
    runDue,
  };
}
