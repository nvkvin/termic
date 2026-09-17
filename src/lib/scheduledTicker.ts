// The one clock for scheduled queue messages (GH #300).
//
// A chat that is already open and idle when a scheduled item's date passes
// has nothing else to wake it: no turn ends, no PTY spawns. So once a minute
// this walks the mounted tabs and bumps `queueKick` on each live, idle agent
// tab holding a due item, which runs TerminalPane's drain.
//
// Not per-tab setTimeouts: a delay over ~24.8 days overflows setTimeout, and
// timers do not track sleep. Not a Rust timer either: sending only ever
// happens in a tab the user has open.
//
// A pass with nothing due writes NOTHING to the store (docs/performance.md
// bear trap 8), so an app with no schedules pays one cheap walk a minute.

import { useApp } from "@/store/app";
import { hasDueScheduled } from "@/lib/scheduledQueue";
import type { TerminalTab } from "@/lib/types";

const TICK_MS = 60_000;
let timer: number | null = null;

/** One pass. Returns how many tabs it kicked (the test seam). */
export function scheduledTickNow(now: number = Date.now()): number {
  const st = useApp.getState();
  const kicks: Array<[string, string]> = [];
  for (const [taskId, tabs] of Object.entries(st.tabs)) {
    for (const t of tabs ?? []) {
      if (t.type !== "terminal") continue;
      const tt = t as TerminalTab;
      // Busy agents are drained by their own done; dead ones have nothing
      // to type into.
      if (!tt.ptyId || tt.workState === "working") continue;
      if (hasDueScheduled(tt.queue, now)) kicks.push([taskId, tt.id]);
    }
  }
  for (const [taskId, tabId] of kicks) {
    const cur = useApp.getState().tabs[taskId]?.find(t => t.id === tabId) as TerminalTab | undefined;
    if (cur) useApp.getState().patchTab(taskId, tabId, { queueKick: (cur.queueKick ?? 0) + 1 });
  }
  return kicks.length;
}

/** Start the ticker. Idempotent; called from App once `loadAll` resolved. */
export function initScheduledTicker() {
  if (timer !== null) return;
  timer = window.setInterval(() => { scheduledTickNow(); }, TICK_MS);
}
