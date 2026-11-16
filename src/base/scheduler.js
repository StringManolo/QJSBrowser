/* Tiny cooperative scheduler for CPU-heavy work (image decode + resample).
 *
 * QuickJS is single-threaded, so heavy work can't run "in the background".
 * What we CAN do is split it into small tasks and run only ONE per event-loop
 * iteration. Between two tasks the loop polls epoll again, so a keypress or a
 * mouse click waits at most for the task that is currently running, never for
 * the whole queue. */
export function createScheduler() {
  const tasks = [];
  return {
    defer(fn)  { tasks.push(fn); },
    hasWork()  { return tasks.length > 0; },
    pending()  { return tasks.length; },
    runOne()   { const fn = tasks.shift(); if (fn) fn(); },
    clear()    { tasks.length = 0; },
  };
}
