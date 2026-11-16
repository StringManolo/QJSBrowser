/* Lightweight mutation notification for the DOM.
 *
 * Node/Element mutators call notifyMutation(); createController registers
 * a hook that marks the active tab dirty and requests a re-render. Cheap
 * (one function pointer). Bulk mutations (initial parse) collapse into a
 * single notify via beginMutationBatch()/endMutationBatch(). */

let hook = null;
let batchDepth = 0;
let pendingInBatch = false;

export function setMutationHook(fn) { hook = fn; }

export function notifyMutation() {
  if (batchDepth > 0) { pendingInBatch = true; return; }
  if (!hook) return;
  try { hook(); } catch (_) {}
}

export function beginMutationBatch() { batchDepth++; }

export function endMutationBatch() {
  if (batchDepth === 0) return;
  batchDepth--;
  if (batchDepth === 0 && pendingInBatch) {
    pendingInBatch = false;
    if (hook) try { hook(); } catch (_) {}
  }
}
