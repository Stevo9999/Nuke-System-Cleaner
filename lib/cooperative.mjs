// lib/cooperative.mjs: run long file-system work without freezing the Electron main process.
// A "cooperative" function is a generator that yields at safe checkpoints (between two entries, never in the middle of a
// check). ONE implementation then serves both callers: runSync drives it to the end (the CLI and the existing sync API,
// byte-for-byte the same order of operations), runAsync hands the event loop back every `every` checkpoints so window
// events, IPC and the confirm page's connection keep flowing. The checks themselves are never skipped or reordered.
export const yieldNow = () => new Promise(resolve => setImmediate(resolve));

export function runSync(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

export async function runAsync(gen, { every = 50 } = {}) {
  let n = 0;
  let r = gen.next();
  while (!r.done) {
    if (++n >= every) { n = 0; await yieldNow(); }
    r = gen.next();
  }
  return r.value;
}
