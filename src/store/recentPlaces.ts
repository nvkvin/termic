// Where you were looking before this, across tasks and tabs (⌃⇥).
//
// Every other way to move around termic is POSITIONAL: ⌥↑/↓ walk the sidebar
// rows, ⌥⌘↑/↓ cycle awake tasks, ⌥⌘←/→ move between panes, ⇧⌘[ / ⇧⌘] cycle
// tabs, ⌘1..9 jump by index. None of them answers "take me back to the thing I
// was just looking at", which with eight agents open is the question you ask
// most — and the tab two slots to the left is not the tab you were in.
//
// A "place" is a (task, tab) pair rather than either alone, because that is
// what was actually on screen. Used inside one task it degrades exactly into
// cycling that task's tabs.
//
// Deliberately its own store, like `navHistory`, NOT a field on `useApp`:
//   - A write here notifies nobody subscribed to `useApp`. The app store is
//     ~233 keys and every mounted task re-runs its selectors on each write
//     (docs/performance.md bear trap 8); a ring nothing renders has no business
//     in there.
//   - It is fed by a SUBSCRIPTION rather than from inside the setters, so all
//     30 call sites of setActiveTask / setActiveTabId are covered without
//     touching one of them: deep links, the CLI, the command palette, race
//     boards, LSP navigation and the sidebar all record for free. That
//     subscription lives in `lib/recentPlacesTracker.ts`, not here: `app.ts`
//     prunes this store, so this store must not import `app.ts` back. Every
//     store app.ts prunes (race, fileViewed, codeIntel, navHistory) is
//     standalone for the same reason.

import { create } from "zustand";

export interface Place {
  taskId: string;
  tabId: string;
}

/** How many places the ring remembers. Matches `paneHistory`'s cap: this is a
 *  ring you walk by tapping a key, not an archive. Past a handful you reach for
 *  the sidebar or ⌘P instead. */
export const PLACES_CAP = 10;

export function samePlace(a: Place, b: Place): boolean {
  return a.taskId === b.taskId && a.tabId === b.tabId;
}

/** Fold a place in at the front, one entry per place (revisiting moves it up
 *  rather than adding a duplicate). Returns `prev` UNCHANGED when it is already
 *  the head — callers rely on that to skip a pointless store write. */
export function pushPlace(prev: Place[], place: Place, cap = PLACES_CAP): Place[] {
  if (prev.length && samePlace(prev[0], place)) return prev;
  return [place, ...prev.filter(p => !samePlace(p, place))].slice(0, cap);
}

interface RecentPlacesState {
  /** Newest first. The head is normally where you are now. */
  places: Place[];
  push: (place: Place) => void;
  /** Drop everything for tasks that no longer exist. */
  pruneTo: (liveTaskIds: string[]) => void;
  reset: () => void;
}

export const useRecentPlaces = create<RecentPlacesState>((set, get) => ({
  places: [],

  push: (place) => {
    const next = pushPlace(get().places, place);
    if (next === get().places) return;   // no-op writes re-run selectors
    set({ places: next });
  },

  pruneTo: (liveTaskIds) => {
    const live = new Set(liveTaskIds);
    const { places } = get();
    const kept = places.filter(p => live.has(p.taskId));
    if (kept.length === places.length) return;
    set({ places: kept });
  },

  reset: () => {
    if (!get().places.length) return;
    set({ places: [] });
  },
}));

// ───────────────────────── recording ─────────────────────────

// Suspended while a ⌃⇥ walk is in flight. The walk moves through places on its
// way somewhere, and recording each one would reorder the ring under the very
// next keypress. A module-local flag rather than a parameter because the
// recorder is a SUBSCRIBER, not a caller: there is no call site to thread
// anything through.
let suspended = false;

export function suspendRecording(): void { suspended = true; }
export function resumeRecording(): void { suspended = false; }
export function isRecordingSuspended(): boolean { return suspended; }
