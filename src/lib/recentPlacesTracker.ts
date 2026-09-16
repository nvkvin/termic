// Feeds the ⌃⇥ ring from whatever is on screen.
//
// Separate from the store itself because `app.ts` prunes that store, so the
// store must not import `app.ts` back — the same reason race / fileViewed /
// codeIntel / navHistory are all standalone. This module is the one that knows
// about both.

import { useApp } from "@/store/app";
import { useRecentPlaces, isRecordingSuspended, type Place } from "@/store/recentPlaces";

/**
 * The place currently on screen, or null when there is none.
 *
 * Null is a real answer twice over: the Dashboard and History have no active
 * task, and a split-pane tab is not a place. `activeTab[taskId]` is the MAIN
 * pane's pointer, so walking to a pane tab would point the main strip at a tab
 * it does not own and TaskView's `mainTabs` filter would render nothing. Every
 * main-strip navigator filters `paneId` the same way (see the `tabs` local in
 * useShortcuts). Split panes have ⌥⌘←/→ of their own.
 */
export function currentPlace(): Place | null {
  const s = useApp.getState();
  const taskId = s.activeTaskId;
  if (!taskId) return null;
  const tabId = s.activeTab[taskId];
  if (!tabId) return null;
  const tab = (s.tabs[taskId] ?? []).find(t => t.id === tabId);
  if (!tab || tab.paneId) return null;
  return { taskId, tabId };
}

/**
 * Places from the ring that can still be returned to for FREE, newest first.
 *
 * `mountedTasks` is the load-bearing half, and the easy one to leave out.
 * `stopTask` evicts a task from it and kills its PTYs but keeps the task and
 * its tabs, so a "does this tab still exist?" check passes and ⌃⇥ would
 * RESURRECT a task the user explicitly stopped, respawning its agent. Same for
 * `closeTab`'s last-main-tab path, which also evicts. Navigation must never
 * start a process.
 *
 * Archived tasks are excluded here as well as by the `pruneTo` in `loadAll`,
 * because archiving reaches that prune only after its refetch: for the moment
 * in between, the task is archived, MainArea has already stopped rendering it,
 * and a step onto it would show an empty pane.
 */
export function livePlaces(): Place[] {
  const s = useApp.getState();
  const archived = new Set(s.tasks.filter(t => t.archived).map(t => t.id));
  return useRecentPlaces.getState().places.filter(p =>
    s.mountedTasks.has(p.taskId)
    && !archived.has(p.taskId)
    && (s.tabs[p.taskId] ?? []).some(t => t.id === p.tabId && !t.paneId),
  );
}

/**
 * Start recording. Returns an unsubscribe, and is safe to call twice.
 *
 * The push is COALESCED into a microtask, which is not an optimisation.
 * Picking a task and a tab is one act that three call sites perform as two
 * calls (`Sidebar`, ⌥↑/↓ in useShortcuts, ⇧⌘A in waitingAgents), and
 * `setActiveTask` alone does three writes in a row. Recording each write
 * separately would file a place the user never looked at: clicking task B's
 * second tab while in task A would leave the ring reading [B/2, B/1, A/x], so
 * the very next ⌃⇥ would go to B/1 instead of back to A — wrong on the
 * commonest path there is.
 *
 * A microtask, never requestAnimationFrame: rAF is frozen while the window is
 * occluded (docs/gotchas.md), and the ring would silently stop recording
 * whenever termic sat on another Space.
 */
let installed: (() => void) | null = null;

export function installRecentPlacesTracker(): () => void {
  if (installed) return installed;

  let pending = false;
  const flush = () => {
    pending = false;
    if (isRecordingSuspended()) return;
    const place = currentPlace();
    if (place) useRecentPlaces.getState().push(place);
  };

  const unsub = useApp.subscribe((state, prev) => {
    if (state.activeTaskId === prev.activeTaskId && state.activeTab === prev.activeTab) return;
    if (pending) return;
    pending = true;
    queueMicrotask(flush);
  });

  installed = () => { unsub(); installed = null; };
  return installed;
}
