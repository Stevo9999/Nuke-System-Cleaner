// app/main/question.mjs
// In-window yes/no questions (no native message boxes). The main renderer shows the question; the answer comes back through
// the fixed channel nuke:question:answer. Pure: `send(payload)` is injected, so this is unit-testable display-less.
// Rules: one question at a time (a second concurrent ask is answered false at once and does not disturb the first); an answer
// counts only while a question is pending and only once (late/duplicate answers are ignored); cancel() (window closed, quit,
// failure to show) answers false.
const KINDS = new Set(["permanent", "restore", "action", "folderapp", "restart"]);

export function createQuestionBroker({ send }) {
  let pending = null; // { resolve, id }
  let seq = 0;

  function ask(kind, message) {
    if (!KINDS.has(kind) || typeof message !== "string" || pending) return Promise.resolve(false);
    return new Promise(resolve => {
      const id = ++seq;
      pending = { resolve, id };
      try { send({ id, kind, message }); } catch { pending = null; resolve(false); }
    });
  }

  // answer(value) -> true when it settled the pending question.
  function answer(value) {
    if (!pending || typeof value !== "boolean") return false;
    const p = pending;
    pending = null;
    p.resolve(value);
    return true;
  }

  function cancel() {
    if (!pending) return;
    const p = pending;
    pending = null;
    p.resolve(false);
  }

  return { ask, answer, cancel, isPending: () => pending !== null };
}
