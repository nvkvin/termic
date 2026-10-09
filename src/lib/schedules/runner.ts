// The schedule runner (GH #300): the clock that fires recurring schedules, and
// the path from a due slot to a run with its prompt typed in.
//
// One JS ticker on the `initPrStatusPoller` model: started from App once
// `loadAll` resolved, idempotent, one pass immediately and then every minute.
// No Rust timer and no sleep loop (docs/performance.md bear trap 9), and a
// pass where nothing is due writes NOTHING (bear trap 8): it reads the task
// list and returns.
//
// It runs while this webview is alive, which is the whole ceiling: Termic
// running, windowless mode included (WebKit clamps a hidden webview's timers
// to 1 Hz, which a 60s interval does not notice), and for a non-root profile
// only while that profile's window is open, because closing one destroys it
// (docs/profiles.md). There is no daemon; launchd around `termic new` is the
// answer for a closed app.
//
// A run is a new main-checkout task in the parent's group, created with the
// settings `runSpecFromParent` derives (the ONE inheritance point) and given
// its prompt through lib/agentDelivery.ts, the same delivery `termic new`
// uses. What happens when a run ends lives in lib/schedules/watcher.ts.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePromptLibrary } from "@/store/prompts";
import { i18n } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import { startArchive } from "@/lib/archiveTask";
import { withCreateLock } from "@/lib/createLock";
import { markUnattendedSpawn } from "@/lib/unattendedSpawns";
import { nextGroupColor } from "@/lib/taskGroups";
import { workDoneCapable } from "@/lib/agents";
import { deliverPromptWhenReady, waitForAgentPty } from "@/lib/agentDelivery";
import { decidePass, latestSlotAtOrBefore, type PassAction } from "@/lib/schedules/slots";
import { appendRun, patchEntry } from "@/lib/schedules/history";
import {
  composePrompt, reportPath, reportStem, runName, runPrompt, runRefusal, runSpecFromParent,
  stemOfReport, uniqueName, type RunSpec,
} from "@/lib/schedules/runSpec";
import { editedSchedule, newSchedule, sameSchedule, type ScheduleInput } from "@/lib/schedules/record";
import type { ScheduleRun, Task, TaskSchedule } from "@/lib/types";

const TICK_MS = 60_000;
let timer: number | null = null;
let ticking: Promise<number> | null = null;

/** Run task id -> parent id, for every run this session started and has not
 *  seen end. THE overlap lock: a parent with a run in here gets its next slot
 *  skipped, and Run now refuses. Every way a run ends has to delete its id,
 *  or one broken run blocks its schedule for the rest of the session. Not in
 *  the store: nothing renders it, and a write here must cost no selector. */
const inFlight = new Map<string, string>();

/** Parents whose run is being created right now, before its id is known. */
const starting = new Set<string>();

/** Parent id -> the newest slot this session acted on. A second guard over
 *  `last_slot`: two writers racing a load-modify-save of one task file can
 *  lose a write, and the next `loadAll` would hand a pass the stale value. */
const actedSlot = new Map<string, number>();

/** Per-parent chain, so the ticker and the end-of-run watcher can never write
 *  over each other's history entry. */
const chains = new Map<string, Promise<unknown>>();

/** Whether `taskId` is a scheduled run this session has not seen end. */
export function isRunInFlight(taskId: string): boolean {
  return inFlight.has(taskId);
}

export function parentHasRunInFlight(parentId: string): boolean {
  if (starting.has(parentId)) return true;
  for (const p of inFlight.values()) if (p === parentId) return true;
  return false;
}

/** The in-flight runs, for the watcher. */
export function inFlightRuns(): ReadonlyMap<string, string> {
  return inFlight;
}

/** Release a run from the overlap lock. */
export function releaseRun(runTaskId: string): void {
  inFlight.delete(runTaskId);
}

function enqueue<T>(parentId: string, op: () => Promise<T>): Promise<T> {
  const prev = chains.get(parentId) ?? Promise.resolve();
  const run = prev.then(op, op);
  chains.set(parentId, run);
  const done = () => { if (chains.get(parentId) === run) chains.delete(parentId); };
  run.then(done, done);
  return run;
}

/** Change one parent's schedule. `fn` sees the LATEST record (read inside the
 *  chain) and returns the next one, or null for "nothing to change". Only a
 *  real change reaches disk and the store. */
export function mutateSchedule(
  parentId: string,
  fn: (s: TaskSchedule) => TaskSchedule | null,
): Promise<TaskSchedule | null> {
  return enqueue(parentId, async () => {
    const cur = useApp.getState().tasks.find(t => t.id === parentId)?.schedule;
    if (!cur) return null;
    const next = fn(cur);
    if (!next || sameSchedule(cur, next)) return null;
    await ipc.taskSetSchedule(parentId, next);
    useApp.getState().setTaskSchedule(parentId, next);
    return next;
  });
}

/** A run task that still exists and is not archived. */
function holdsLiveRun(runTaskId: string): boolean {
  const t = useApp.getState().tasks.find(x => x.id === runTaskId);
  return !!t && !t.archived;
}

function usedStems(s: TaskSchedule): Set<string> {
  const out = new Set<string>();
  for (const e of s.history) {
    const stem = stemOfReport(e.report);
    if (stem) out.add(stem);
  }
  return out;
}

function libraryBody(promptId: string): string | null {
  return usePromptLibrary.getState().prompts.find(p => p.id === promptId)?.body ?? null;
}

// ─────────────────────────── the clock ───────────────────────────────

/** One pass at `now`. Resolves with how many schedules it acted on (the test
 *  seam, and `window.__termic.scheduleTickNow`). A pass already in progress
 *  is joined rather than doubled. */
export function scheduleTickNow(now: number = Date.now()): Promise<number> {
  if (ticking) return ticking;
  ticking = pass(now).finally(() => { ticking = null; });
  return ticking;
}

async function pass(now: number): Promise<number> {
  hooks.tick?.(now);
  const parents = useApp.getState().tasks.filter(t => t.schedule && !t.archived);
  let count = 0;
  for (const parent of parents) {
    const s = parent.schedule!;
    const guard = actedSlot.get(parent.id);
    const last = guard != null && (s.last_slot == null || guard > s.last_slot) ? guard : s.last_slot;
    const action = decidePass({ ...s, last_slot: last }, now, parentHasRunInFlight(parent.id));
    if (action.kind === "none") continue;
    actedSlot.set(parent.id, action.slot);
    count++;
    try {
      await act(parent.id, s, action);
    } catch (e) {
      console.warn("[schedules] pass failed for", parent.id, e);
    }
  }
  return count;
}

async function act(parentId: string, s: TaskSchedule, action: Exclude<PassAction, { kind: "none" }>): Promise<void> {
  if (action.kind === "missed") {
    await mutateSchedule(parentId, cur => ({
      ...cur,
      last_slot: action.slot,
      history: appendRun(cur.history, { slot: action.slot, outcome: "missed", count: action.count }, holdsLiveRun),
    }));
    return;
  }
  // Slots in the same gap before the one acted on: recorded as one streak.
  const prevSlot = action.missedBefore > 0 ? latestSlotAtOrBefore(s.cadence, action.slot - 1) : null;
  const earlier: ScheduleRun | null = prevSlot != null
    ? { slot: prevSlot, outcome: "missed", count: action.missedBefore }
    : null;
  if (action.kind === "skip") {
    await mutateSchedule(parentId, cur => {
      let h = cur.history;
      if (earlier) h = appendRun(h, earlier, holdsLiveRun);
      h = appendRun(h, { slot: action.slot, outcome: "skipped" }, holdsLiveRun);
      return { ...cur, last_slot: action.slot, history: h };
    });
    return;
  }
  await fireRun(parentId, action.slot, { manual: false, earlier });
}

// ─────────────────────────── firing ──────────────────────────────────

export type FireResult =
  | { kind: "started"; runId: string }
  | { kind: "busy" }
  | { kind: "failed"; error: string };

/** Run a schedule now, outside its cadence. Refused while its previous run is
 *  still going (the same overlap rule a slot gets). Never moves `last_slot`. */
export async function runScheduleNow(parentId: string, now: number = Date.now()): Promise<FireResult> {
  if (parentHasRunInFlight(parentId)) return { kind: "busy" };
  return fireRun(parentId, now, { manual: true, earlier: null });
}

async function fireRun(
  parentId: string,
  slot: number,
  opts: { manual: boolean; earlier: ScheduleRun | null },
): Promise<FireResult> {
  // Claimed synchronously, so a double-clicked Run now cannot start two.
  if (starting.has(parentId)) return { kind: "busy" };
  starting.add(parentId);
  try {
    return await fireRunClaimed(parentId, slot, opts);
  } finally {
    starting.delete(parentId);
  }
}

async function fireRunClaimed(
  parentId: string,
  slot: number,
  opts: { manual: boolean; earlier: ScheduleRun | null },
): Promise<FireResult> {
  const st = useApp.getState();
  const parent = st.tasks.find(t => t.id === parentId);
  const s = parent?.schedule;
  if (!parent || !s) return { kind: "failed", error: "gone" };

  const stem = reportStem(slot, usedStems(s));
  const isThis = (e: ScheduleRun) => e.slot === slot && e.outcome === "running";
  // Record the slot BEFORE creating anything. A crash between the two then
  // costs one run (the next launch resolves the entry as failed) instead of
  // running the slot twice.
  await mutateSchedule(parentId, cur => {
    let h = cur.history;
    if (opts.earlier) h = appendRun(h, opts.earlier, holdsLiveRun);
    h = appendRun(h, {
      slot, outcome: "running", report: reportPath(cur.slug, stem), ...(opts.manual ? { manual: true } : {}),
    }, holdsLiveRun);
    return { ...cur, last_slot: opts.manual ? cur.last_slot : slot, history: h };
  });
  const fail = async (error: string): Promise<FireResult> => {
    await mutateSchedule(parentId, cur => {
      const h = patchEntry(cur.history, isThis, { outcome: "failed", error });
      return h ? { ...cur, history: h } : null;
    });
    return { kind: "failed", error };
  };

  // Checked when the slot fires, not only in the dialog: a parent can be
  // switched to Docker, or to an agent with no done signal, after its
  // schedule was made.
  const refusal = runRefusal(parent, workDoneCapable(parent.cli, st.agents));
  if (refusal) return fail(refusal);
  const body = s.prompt_id ? libraryBody(s.prompt_id) : undefined;
  if (body === null) return fail("prompt");
  const composed = composePrompt(body, s.prompt);
  if (!composed.trim()) return fail("prompt");

  const spec = runSpecFromParent(parent, st.projects.find(p => p.id === parent.project_id));
  let run: Task;
  try {
    run = await createRun(parent, s, slot, spec);
  } catch (e) {
    return fail(String((e as Error)?.message ?? e));
  }
  inFlight.set(run.id, parentId);
  // The account override first: the spawn reads it (D1, runs inherit it).
  for (const [agent, account] of Object.entries(spec.accounts)) {
    await ipc.taskSetAccount(run.id, agent, account).catch(() => {});
  }
  // Before anything mounts, so the first spawn composes UNATTENDED_SPAWN_ARGS
  // and a startup menu cannot swallow the prompt.
  markUnattendedSpawn(run.id);
  // Stamps spawned_by and joins the parent's group (whatever group the parent
  // is in), before loadAll so the row first renders inside it.
  await ipc.taskLinkSpawn(run.id, parentId, nextGroupColor(useApp.getState().tasks)).catch(() => {});
  await mutateSchedule(parentId, cur => {
    const h = patchEntry(cur.history, e => isThis(e) && !e.run_task_id, { run_task_id: run.id });
    return h ? { ...cur, history: h } : null;
  });
  await useApp.getState().loadAll();
  // Mounted, never activated: it runs in the background like `termic new`
  // without --open, and steals no focus.
  useApp.getState().mountTasks([run.id]);
  void deliver(run.id, parentId, runPrompt(composed, s, stem));
  return { kind: "started", runId: run.id };
}

/** Create the run's task: the project's main checkout, never a worktree (no
 *  branch, no disk, no setup script, and a plain folder has no worktree mode
 *  at all), named for its slot. Inside the app-wide create lock, with the
 *  live names re-read from disk like `createTask` does. */
function createRun(parent: Task, s: TaskSchedule, slot: number, spec: RunSpec): Promise<Task> {
  return withCreateLock(async () => {
    const all = await ipc.tasksList().catch(() => useApp.getState().tasks);
    const taken = all.filter(t => !t.archived && t.project_id === parent.project_id).map(t => t.name);
    const name = uniqueName(runName(s.name, slot), taken);
    return ipc.taskOpenRepo(
      parent.project_id, spec.cli, name, spec.sandbox,
      undefined, undefined, undefined, spec.agentArgs, spec.yolo, spec.memberPaths,
    );
  });
}

/** Wait for the run's agent and type its prompt. Runs in the background; the
 *  watcher takes it from a delivered prompt. */
async function deliver(runId: string, parentId: string, prompt: string): Promise<void> {
  const spawned = await waitForAgentPty(runId);
  const r = await deliverPromptWhenReady(runId, prompt, spawned);
  if (r.ok) {
    hooks.delivered?.(runId, parentId);
    return;
  }
  inFlight.delete(runId);
  await mutateSchedule(parentId, cur => {
    const h = patchEntry(cur.history, e => e.run_task_id === runId, { outcome: "failed", error: r.error });
    return h ? { ...cur, history: h } : null;
  });
  hooks.failed?.(runId, parentId, r.error);
}

/** Set by the watcher (lib/schedules/watcher.ts), which owns everything after
 *  delivery. Hooks rather than an import, so the watcher can import this
 *  module and not the other way round. */
export interface RunHooks {
  /** The prompt landed: start watching for the run's end. */
  delivered?: (runId: string, parentId: string) => void;
  /** The prompt never landed; the entry already says failed. */
  failed?: (runId: string, parentId: string, error: string) => void;
  /** Every pass of the minute ticker, with its `now`. */
  tick?: (now: number) => void;
}
let hooks: RunHooks = {};
export function setRunHooks(h: RunHooks): void {
  hooks = h;
}

// ─────────────────────── creating and editing ────────────────────────

export interface CreateScheduleArgs {
  projectId: string;
  /** "Schedule..." on an existing task: it becomes the parent. */
  parentTaskId?: string;
  /** A NEW parent's agent settings, as the dialog collected them. */
  agent?: Pick<RunSpec, "cli" | "agentArgs" | "yolo" | "sandbox" | "memberPaths">;
  input: ScheduleInput;
}

/** Create a schedule and return its parent's id. A new parent is a
 *  main-checkout task named for the schedule, created UNMOUNTED: its agent
 *  starts when the user opens it, so a schedule costs nothing between runs.
 *  The parent leads the group its runs join, collapsed when this creates it. */
export async function createSchedule(a: CreateScheduleArgs, now: number = Date.now()): Promise<string> {
  let parentId = a.parentTaskId;
  let created = false;
  if (!parentId) {
    const agent = a.agent;
    if (!agent) throw new Error("a new schedule needs an agent");
    const parent = await withCreateLock(async () => {
      const all = await ipc.tasksList().catch(() => useApp.getState().tasks);
      const taken = all.filter(t => !t.archived && t.project_id === a.projectId).map(t => t.name);
      return ipc.taskOpenRepo(
        a.projectId, agent.cli, uniqueName(a.input.name.trim(), taken), agent.sandbox,
        undefined, undefined, undefined, agent.agentArgs, agent.yolo, agent.memberPaths,
      );
    });
    parentId = parent.id;
    created = true;
  }
  const all = await ipc.tasksList().catch(() => useApp.getState().tasks);
  const takenSlugs = all
    .filter(t => t.project_id === a.projectId && t.schedule)
    .map(t => t.schedule!.slug);
  const schedule = newSchedule(a.input, now, takenSlugs);
  try {
    await ipc.taskSetSchedule(parentId, schedule);
  } catch (e) {
    // Leave nothing half-made behind: the parent existed only for this.
    // Archive first WITHOUT the scripts, then delete: `task_delete` on a live
    // task archives it with the project's archive script, which would run in
    // the user's live checkout; on an archived main-checkout task it only
    // removes the record.
    if (created) {
      await ipc.taskArchive(parentId, false, true).catch(() => {});
      await ipc.taskDelete(parentId).catch(() => {});
    }
    throw e;
  }
  const parent = all.find(t => t.id === parentId) ?? useApp.getState().tasks.find(t => t.id === parentId);
  const foundGroup = !parent?.group;
  if (foundGroup) await ipc.taskGroupNew(parentId, nextGroupColor(useApp.getState().tasks)).catch(() => {});
  await useApp.getState().loadAll();
  // After loadAll, which prunes collapse state for groups that do not exist
  // yet. A group the parent was already in keeps whatever state it had.
  const gid = useApp.getState().tasks.find(t => t.id === parentId)?.group?.id;
  if (foundGroup && gid) useApp.getState().setTaskGroupCollapsed(gid, true);
  actedSlot.delete(parentId);
  return parentId;
}

/** Edit a schedule. See `editedSchedule` for when `last_slot` restarts.
 *
 *  A rename also renames the parent task while the parent still carries the
 *  schedule's old name (the parent a new schedule creates is named after it),
 *  so the sidebar group, which follows its lead's name, agrees with the
 *  Scheduled view. A parent named something else ("Schedule..." on an
 *  existing task) keeps its own name. Task names are unique per project, so a
 *  rename Rust refuses leaves the parent as it was and says why. */
export async function updateSchedule(
  parentId: string,
  patch: Partial<ScheduleInput> & { enabled?: boolean },
  now: number = Date.now(),
): Promise<TaskSchedule | null> {
  actedSlot.delete(parentId);
  const before = useApp.getState().tasks.find(t => t.id === parentId);
  const oldName = before?.schedule?.name;
  const next = await mutateSchedule(parentId, s => editedSchedule(s, patch, now));
  if (next && before && oldName !== undefined && next.name !== oldName
      && before.name.trim().toLowerCase() === oldName.trim().toLowerCase()) {
    try {
      await ipc.taskRename(parentId, next.name);
      await useApp.getState().loadAll();
    } catch (e) {
      useUI.getState().pushToast(
        i18n.t("backend:schedules.parentRenameFailed", { error: String((e as Error)?.message ?? e) }),
        "error",
      );
    }
  }
  return next;
}

export interface DeleteScheduleOptions {
  deleteReports?: boolean;
  archiveTasks?: boolean;
}

/** Remove a schedule (the parent and its runs stay, as ordinary tasks), and
 *  with `deleteReports` its report files too. With `archiveTasks`, archives
 *  the parent and all its run tasks and deletes its reports. A kept folder is
 *  no longer cleaned up: the schedule that owned it is gone. */
export function deleteSchedule(
  parentId: string,
  options?: boolean | DeleteScheduleOptions,
): Promise<void> {
  const opts: DeleteScheduleOptions = typeof options === "boolean"
    ? { deleteReports: options }
    : (options ?? {});
  const shouldDeleteReports = opts.deleteReports ?? opts.archiveTasks ?? false;
  const shouldArchiveTasks = opts.archiveTasks ?? false;

  return enqueue(parentId, async () => {
    const parent = useApp.getState().tasks.find(t => t.id === parentId);
    const s = parent?.schedule;
    if (!parent || !s) return;
    await ipc.taskSetSchedule(parentId, null);
    useApp.getState().setTaskSchedule(parentId, null);
    actedSlot.delete(parentId);
    if (shouldDeleteReports) await ipc.scheduleDeleteReports(parent.project_id, s.slug).catch(() => {});
    if (shouldArchiveTasks) {
      const runIds = new Set<string>();
      for (const t of useApp.getState().tasks) {
        if (!t.archived && (t.spawned_by === parentId || s.history.some(h => h.run_task_id === t.id))) {
          runIds.add(t.id);
        }
      }
      for (const runId of runIds) {
        inFlight.delete(runId);
        await startArchive(runId, false, true).catch(() => {});
      }
      const parentTask = useApp.getState().tasks.find(t => t.id === parentId);
      if (parentTask && !parentTask.archived) {
        inFlight.delete(parentId);
        await startArchive(parentId, false, true).catch(() => {});
      }
    }
  });
}

// ─────────────────────────── lifecycle ───────────────────────────────

/** Start the clock. Idempotent; called from App once `loadAll` resolved. */
export function initScheduleRunner(): void {
  if (timer !== null) return;
  timer = window.setInterval(() => { void scheduleTickNow(); }, TICK_MS);
  void scheduleTickNow();
}

/** Test seam: forget everything this module remembers. */
export function __resetScheduleRunnerForTests(): void {
  inFlight.clear();
  starting.clear();
  actedSlot.clear();
  chains.clear();
  ticking = null;
  hooks = {};
}
