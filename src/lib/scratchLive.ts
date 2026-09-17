// The OPEN scratchpads, by task and pad id, so something outside the editor
// (the CLI's `scratchpad` verbs) can reach the buffer the human is looking at.
//
// An open pad's truth is its CodeMirror buffer, not the file behind it: the
// file lags typing by the flush debounce, and an editor never re-reads it
// (EditorPane loads a pad once). So a write from an agent has to go INTO the
// buffer, where it shows immediately and is undoable, and a read has to come
// out of it. A pad that is not open has no buffer and is plain IPC.
//
// A module map rather than store state: nothing renders from it, and a
// registration on every pad mount would otherwise be a store write.

export interface LivePad {
  /** The buffer as the window shows it. */
  text(): string;
  /** Replace the buffer, or add to its end, then flush it to disk. */
  write(text: string, append: boolean): void;
}

const live = new Map<string, LivePad>();
// Task and pad ids are both [A-Za-z0-9_-] (scratch_id_ok), so "/" cannot
// appear in either and the join is unambiguous.
const key = (taskId: string, scratchId: string) => `${taskId}/${scratchId}`;

/** Register an open pad's editor. Returns the unregister, which only removes
 *  THIS registration (a remount may already have replaced it). */
export function registerLivePad(taskId: string, scratchId: string, pad: LivePad): () => void {
  const k = key(taskId, scratchId);
  live.set(k, pad);
  return () => {
    if (live.get(k) === pad) live.delete(k);
  };
}

export function livePad(taskId: string, scratchId: string): LivePad | undefined {
  return live.get(key(taskId, scratchId));
}
