// Creating, restoring and discarding scratchpad tabs (GH #244).
//
// A pad is an unsaved buffer that happens to survive restarts, scoped to ONE
// task. The buffer and its index record live under `<data_dir>/scratch/<taskId>/`
// (Rust side), never inside the worktree.
//
// This module owns everything about a pad EXCEPT the buffer itself, which
// EditorPane reads/writes directly (see its `scratch` branch), and the close
// prompt, which lives in lib/closeTab.ts with every other close.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import type { ScratchTab } from "@/lib/types";
import { SCRATCH_UNTITLED } from "@/lib/scratchTitle";
import { PROFILE_NS } from "@/lib/profileScope";

/** The pads already open in `taskId`'s strip, by scratch id. */
function openScratchIds(taskId: string): Set<string> {
  return new Set(
    (useApp.getState().tabs[taskId] ?? [])
      .filter((t): t is ScratchTab => t.type === "scratch")
      .map(t => t.scratchId),
  );
}

export function profileScratchTargetId(): string {
  if (!PROFILE_NS) return "profile_root";
  const slug = PROFILE_NS.startsWith("profile-") && PROFILE_NS.endsWith(":")
    ? PROFILE_NS.slice("profile-".length, -1)
    : "";
  return slug ? `profile_${slug}` : "profile_root";
}

export function scratchTargetId(tab: ScratchTab, defaultTaskId?: string): string {
  if (tab.targetId) return tab.targetId;
  if (tab.scope === "global") return "global";
  if (tab.scope === "profile") return profileScratchTargetId();
  if (tab.scope === "project") return `project_${tab.projectId ?? ""}`;
  return defaultTaskId ?? "";
}

export function scratchTab(rec: {
  id: string;
  title?: string;
  syntax?: string;
  scope?: "task" | "project" | "profile" | "global";
  projectId?: string;
  targetId?: string;
  path?: string;
  dirty?: boolean;
}): ScratchTab {
  return {
    id: crypto.randomUUID(),
    type: "scratch",
    scratchId: rec.id,
    title: rec.title || SCRATCH_UNTITLED,
    // Dirty for untitled pads until saved/promoted; real scratch tree files start clean.
    dirty: rec.dirty ?? true,
    ...(rec.scope ? { scope: rec.scope } : {}),
    ...(rec.projectId ? { projectId: rec.projectId } : {}),
    ...(rec.targetId ? { targetId: rec.targetId } : {}),
    ...(rec.path ? { path: rec.path } : {}),
    ...(rec.syntax ? { syntax: rec.syntax } : {}),
    // NEVER `preview: true`. openPreviewTab recycles the first tab carrying
    // that flag, and recycling a pad would silently retarget it at a file.
  };
}

/** Open an existing file in the multi-file scratchpad tree, or create a tab for it. */
export function openScratchFileTab(
  taskId: string,
  scope: "project" | "profile" | "global",
  projectId: string | undefined,
  path: string,
): string {
  const tabs = useApp.getState().tabs[taskId] ?? [];
  const existing = tabs.find(
    (t): t is ScratchTab =>
      t.type === "scratch" &&
      t.scope === scope &&
      (scope === "global" || scope === "profile" || t.projectId === projectId) &&
      t.path === path,
  );
  if (existing) {
    useApp.getState().setActiveTabId(taskId, existing.id);
    return existing.id;
  }
  const leaf = path.split("/").pop() || path;
  const targetId = scope === "global"
    ? "global"
    : scope === "profile"
      ? profileScratchTargetId()
      : `project_${projectId ?? ""}`;
  const tab = scratchTab({
    id: crypto.randomUUID(),
    title: leaf,
    dirty: false,
    scope,
    projectId,
    targetId,
    path,
  });
  useApp.getState().addTab(taskId, tab, { focus: true });
  return tab.id;
}

/** New empty pad in `taskId`, focused. The record is created eagerly (an
 *  empty buffer write) so a crash before the first keystroke still leaves a
 *  pad rather than a tab pointing at nothing. */
export async function newScratchTab(
  taskId: string,
  opts?: { scope?: "task" | "project" | "profile" | "global"; projectId?: string }
): Promise<string> {
  const scratchId = crypto.randomUUID();
  const scope = opts?.scope ?? "task";
  const projectId = scope === "project" ? opts?.projectId : undefined;
  const targetId = scope === "global"
    ? "global"
    : scope === "profile"
      ? profileScratchTargetId()
      : scope === "project"
        ? `project_${projectId ?? ""}`
        : taskId;
  const tab = scratchTab({ id: scratchId, scope, projectId, targetId });
  useApp.getState().addTab(taskId, tab);
  try {
    await ipc.scratchWrite(targetId, scratchId, "");
  } catch (e) {
    useUI.getState().pushToast(i18n.t("backend:scratchTabs.createFailed", { error: String(e) }), "error");
  }
  return tab.id;
}

/** Open an existing shared scratchpad for this scope, or create a new one if none exists. */
export async function openOrCreateScopedScratchTab(
  taskId: string,
  scope: "project" | "profile" | "global",
  projectId?: string,
): Promise<string> {
  const projId = scope === "project" ? projectId : undefined;
  const targetId = scope === "global"
    ? "global"
    : scope === "profile"
      ? profileScratchTargetId()
      : `project_${projId ?? ""}`;
  const existingTab = (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is ScratchTab => t.type === "scratch" && scratchTargetId(t, taskId) === targetId,
  );
  if (existingTab) {
    useApp.getState().setActiveTabId(taskId, existingTab.id);
    return existingTab.id;
  }
  try {
    const list = await ipc.scratchList(targetId);
    if (list.length > 0) {
      const rec = list[0];
      const tab = scratchTab({
        id: rec.id,
        title: rec.title,
        syntax: rec.syntax,
        scope,
        projectId: projId,
        targetId,
      });
      useApp.getState().addTab(taskId, tab, { focus: true });
      return tab.id;
    }
  } catch {
    // fall through to create new pad
  }
  return newScratchTab(taskId, { scope, projectId: projId });
}

/** Tasks with a restore in flight — see the guard below. */
const restoring = new Set<string>();

/** Bring back the task's pads on first entry into it (quit → relaunch →
 *  every pad still there, untouched). Idempotent: a pad already open in the
 *  strip is skipped, so a second call can't double a tab.
 *
 *  Restored unfocused and in index order, behind whatever agent tab the
 *  restore path just seeded: reopening a task should land the user on their
 *  agent, not on a note. */
export async function restoreScratchTabs(taskId: string): Promise<void> {
  // Two restores in flight for one task would both see an empty strip while
  // the other's `scratchList` is still resolving, and each would add every
  // pad. The idempotence check below is not enough on its own because it runs
  // AFTER an await.
  if (restoring.has(taskId)) return;
  restoring.add(taskId);
  try {
    await restoreScratchTabsInner(taskId);
  } finally {
    restoring.delete(taskId);
  }
}

async function restoreScratchTabsInner(taskId: string): Promise<void> {
  let recs: ipc.ScratchRecord[];
  try {
    recs = await ipc.scratchList(taskId);
  } catch {
    // A pad that fails to list is not worth a toast on every task open; the
    // buffers are still on disk and the next launch tries again.
    return;
  }
  const open = openScratchIds(taskId);
  for (const rec of recs) {
    if (open.has(rec.id)) continue;
    useApp.getState().addTab(taskId, scratchTab(rec), { focus: false });
  }
}

/** Delete a pad for good (the close prompt's Discard). The tab is closed by
 *  the caller — this is only the on-disk half. */
export async function discardScratchPad(taskId: string, scratchId: string): Promise<void> {
  try {
    await ipc.scratchDelete(taskId, scratchId);
  } catch (e) {
    useUI.getState().pushToast(i18n.t("backend:scratchTabs.deleteFailed", { error: String(e) }), "error");
  }
}
