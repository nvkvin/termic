// A task's phase is DERIVED at render, from the task record plus the PR
// store, and never stored. That is the whole point: a value computed from
// signals already in memory cannot disagree with the PR chip or the sidebar
// badge, and it cannot go stale, because there is nothing to go stale. PR
// #292 originally shipped a hand-set status field (a pill you set by hand,
// persisted on the task record) and the maintainer rejected it before
// merge, exactly because a hand-maintained signal sitting beside live ones
// drifts: merge a PR without updating the dot and the row shows a merged
// chip next to a stale "In review" with nothing in the system reconciling
// them. See docs/ideas/task-status.md, "What was tried, and why it was
// rejected". This file is the "same question, opposite mechanism" second
// attempt: nothing here is typed by a person.
//
// The decisions baked into the precedence table below:
//
// - Archived beats merged. A shelved task is finished regardless of what its
//   PR did, so `archived` is checked before the PR at all.
// - A draft PR is In progress, not In review. A draft says explicitly that
//   it is not ready to be looked at.
// - A closed, unmerged PR falls back to In progress rather than Backlog.
//   The branch has real work on it, closing usually means "try a different
//   approach", and Backlog would claim nothing has happened here.
// - `changes_requested` stays In review. The PR chip already says so, and a
//   phase that oscillates with every review round is noise, not signal.
// - A failing check does not move the phase. CI is a property of the work,
//   not a stage of it, and the PR chip already turns red.
// - A shell spawn counts as progress because `task_record_spawn` fires for
//   every spawn: `spawn_count > 0` really means "something has run here",
//   not "something is still running".
// - Main-checkout tasks are never looked up by the PR poller at all
//   (`pollableTasks` in src/store/pr.ts skips `is_main_checkout`), so a
//   main-checkout task only ever leaves In progress by being archived.
// - A record written before `last_opened_at` existed shows no age rather
//   than a guessed one (see `taskAgeLabel`).
//
// In practice Backlog is rare. Every GUI create path activates the new task,
// activation spawns its default tab, and that spawn is recorded, so a task
// is In progress within a second of existing. Only a CLI create that never
// opens the task stays in Backlog.

import type { PrStatus, Task } from "./types";
import { relativeDayLabel, daysSince } from "./relativeDay";

export type TaskPhase = "backlog" | "in_progress" | "in_review" | "done";

/** Display order for the dashboard's filter row. */
export const PHASE_ORDER: readonly TaskPhase[] = ["in_progress", "in_review", "done", "backlog"];

export const PHASE_LABEL: Record<TaskPhase, string> = {
  backlog: "Backlog",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

/** What the dashboard says when a filter matches nothing. An explicit map,
 *  not `"Nothing " + PHASE_LABEL[p].toLowerCase()`: that reads fine for three
 *  of the four and produces "Nothing backlog" for the fourth, and a sentence
 *  assembled from a label is a sentence nobody proofreads. */
export const PHASE_EMPTY_LABEL: Record<TaskPhase, string> = {
  backlog: "Nothing in the backlog",
  in_progress: "Nothing in progress",
  in_review: "Nothing in review",
  done: "Nothing done",
};

/**
 * First match wins. `pr` is the live snapshot for this task from
 * `usePr.getState().byTask[id]?.lookup?.pr ?? null`. A lookup that failed
 * (`cli-missing`, `no-remote`, `error`, ...) also has `pr === null`, and
 * that is deliberate: "we do not know if there is a PR" falls through to
 * the agent signals below rather than forcing Backlog, so a task on a
 * machine with no `gh`/`glab` still phases correctly from `spawn_count`.
 */
export function taskPhase(task: Task, pr: PrStatus | null | undefined): TaskPhase {
  if (task.archived || pr?.state === "merged") return "done";
  if (pr?.state === "open") return "in_review";
  if (
    pr?.state === "draft" ||
    pr?.state === "closed" ||
    (task.spawn_count ?? 0) > 0 ||
    task.has_resumable_history
  ) {
    return "in_progress";
  }
  return "backlog";
}

/** Phase totals over a list of tasks, keyed by every {@link TaskPhase} so a
 *  caller never has to guard a missing key. `prOf` looks up the live PR for
 *  one task id, same contract as {@link taskPhase}'s second argument. */
export function phaseCounts(
  tasks: readonly Task[],
  prOf: (taskId: string) => PrStatus | null | undefined,
): Record<TaskPhase, number> {
  const counts: Record<TaskPhase, number> = { backlog: 0, in_progress: 0, in_review: 0, done: 0 };
  for (const task of tasks) {
    counts[taskPhase(task, prOf(task.id))]++;
  }
  return counts;
}

/**
 * The recency half of the answer: phase alone does not say which In
 * progress task you are actually on. Returns `null` when there is nothing
 * to show: no timestamp, an unparseable one, or one so recent ("Today")
 * that showing it would just be noise on a row stamped minutes ago.
 */
export function taskAgeLabel(lastOpenedAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!lastOpenedAt) return null;
  const t = new Date(lastOpenedAt).getTime();
  if (Number.isNaN(t)) return null;
  if (daysSince(lastOpenedAt, now) < 1) return null;
  return relativeDayLabel(lastOpenedAt, now);
}
