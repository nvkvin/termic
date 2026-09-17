// A task's phase is DERIVED at render, from the task record plus the PR
// store plus the git store, and never stored. That is the whole point: a
// value computed from signals already in memory cannot disagree with the PR
// chip or the sidebar badge, and it cannot go stale, because there is nothing
// to go stale. PR #292 originally shipped a hand-set status field (a pill you
// set by hand, persisted on the task record) and the maintainer rejected it
// before merge, exactly because a hand-maintained signal sitting beside live
// ones drifts: merge a PR without updating the dot and the row shows a merged
// chip next to a stale "In review" with nothing in the system reconciling
// them. See docs/ideas/task-status.md, "What was tried, and why it was
// rejected". This file is the "same question, opposite mechanism" second
// attempt: nothing here is typed by a person.
//
// What the four values mean:
//
// - TODO is the state every new task starts in. Creating a task spawns its
//   agent, so a spawn is not evidence anybody has given it work: the agent is
//   sitting at its prompt waiting. Todo is "this exists and nothing has been
//   asked of it yet", which is the common case for a minute or an afternoon,
//   not a rarity.
// - IN PROGRESS begins at the first prompt a human submits into any terminal
//   of the task (`started_at`, stamped once by `markStarted`). That is the
//   earliest moment the app can honestly say work started, and it is a fact
//   about the user, not about a process being alive.
// - IN REVIEW is an open PR, or, with no PR at all, own commits on the branch
//   with a clean tree and nothing unpushed. The second half is what a
//   stopped-and-handed-off task looks like on a repo with no forge, or before
//   anybody opened a PR: the work is committed, the worktree is clean, the
//   remote has it. It deliberately does NOT key on Stop, which is not
//   persisted anywhere and is therefore every task's state after a relaunch.
// - DONE is archived, a merged PR, or the branch reaching the base branch by
//   any route: fast-forward, merge commit, rebase or squash. `merged_into_base`
//   is biased toward false, because a wrong Done tells the user to archive live
//   work.
//
// The decisions baked into the precedence table below:
//
// - Archived beats merged. A shelved task is finished regardless of what its
//   PR did, so `archived` is checked before anything else.
// - A draft PR is In progress, not In review. A draft says explicitly that
//   it is not ready to be looked at.
// - A closed, unmerged PR falls back to In progress rather than Todo. The
//   branch has real work on it, closing usually means "try a different
//   approach", and Todo would claim nothing has happened here.
// - A draft or closed PR also OUTRANKS the git rule: both are an explicit
//   statement by a person about how ready this work is, and a clean pushed
//   branch underneath does not overrule it. This is why the git half of the
//   In review rule requires `pr` to be absent rather than just not-open.
// - `changes_requested` stays In review. The PR chip already says so, and a
//   phase that oscillates with every review round is noise, not signal.
// - A failing check does not move the phase. CI is a property of the work,
//   not a stage of it, and the PR chip already turns red.
// - An unknown `git` (not polled yet, or the lookup failed) falls through to
//   rules 3 and 4, exactly as an unknown `pr` does. "We do not know where the
//   branch stands" must not read as "nothing has happened here".
// - Main-checkout tasks never enter the git rules at all: `pollableTasks` in
//   src/store/taskGit.ts skips `is_main_checkout`, so their `git` is forever
//   undefined. A main-checkout task has no branch of its own to compare, and
//   it leaves In progress by being archived or by its PR.
//
// The phase moves In progress <-> In review with each work cycle: edit
// something and the tree goes dirty, so it drops back to In progress;
// commit and push and it returns to In review. That is truthful rather than
// noisy, and it is a different thing from the review-round oscillation this
// design avoids: `changes_requested` deliberately does not move the phase,
// because the reviewer's opinion is not a change in where the work stands.
// One consequence worth knowing on purpose: a stray untracked file pins a
// task at In progress. That is the intended reading. Unfinished work in the
// worktree is unfinished work, whatever the commits say.

import type { PrStatus, Task, TaskGitState } from "./types";
import { relativeDayLabel, daysSince } from "./relativeDay";

export type TaskPhase = "todo" | "in_progress" | "in_review" | "done";

/** Display order for the dashboard's filter row: lifecycle order, so the row
 *  reads left to right as a task's life. */
export const PHASE_ORDER: readonly TaskPhase[] = ["todo", "in_progress", "in_review", "done"];

export const PHASE_LABEL: Record<TaskPhase, string> = {
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

/** What the dashboard says when a filter matches nothing. An explicit map,
 *  not `"Nothing " + PHASE_LABEL[p].toLowerCase()`: that reads fine for three
 *  of the four and produces "Nothing todo" for the fourth, and a sentence
 *  assembled from a label is a sentence nobody proofreads. */
export const PHASE_EMPTY_LABEL: Record<TaskPhase, string> = {
  todo: "Nothing to do",
  in_progress: "Nothing in progress",
  in_review: "Nothing in review",
  done: "Nothing done",
};

/**
 * First match wins.
 *
 * `pr` is the live snapshot for this task from
 * `usePr.getState().byTask[id]?.lookup?.pr ?? null`. A lookup that failed
 * (`cli-missing`, `no-remote`, `error`, ...) also has `pr === null`, and
 * that is deliberate: "we do not know if there is a PR" falls through to the
 * rules below rather than forcing Todo, so a task on a machine with no
 * `gh`/`glab` still phases from the record and from git.
 *
 * `git` is `useTaskGit.getState().byTask[id]?.state`, which is `undefined`
 * for a task nothing has polled (a main-checkout one, or one the dashboard
 * has not reached yet) and `null` for one whose lookup rejected. Both mean
 * "we do not know", and both fall through the same way.
 */
export function taskPhase(
  task: Task,
  pr: PrStatus | null | undefined,
  git: TaskGitState | null | undefined,
): TaskPhase {
  if (task.archived || pr?.state === "merged" || git?.merged_into_base) return "done";
  if (pr?.state === "open") return "in_review";
  // No PR at all (not merely a non-open one: see the header on why draft and
  // closed outrank this) and the three conditions that together mean handed
  // off: something was committed, nothing is left in the worktree, and the
  // remote has it. `ahead === 0` is strict on purpose, since `null` means
  // there is no remote branch, which is not "nothing left to push".
  // `base_known` is deliberately NOT a condition here: `own_commits` is
  // counted against the BASE BRANCH (`rev-list --count B..T`), which never
  // needed the creation commit, and gating on it would deny In review to
  // every imported worktree and reused branch, whose `base_sha` is None by
  // design. Only `merged_into_base` needs the creation commit, and Rust
  // already folds that in.
  if (
    pr == null && git &&
    git.own_commits >= 1 && !git.dirty && git.ahead === 0
  ) {
    return "in_review";
  }
  if (pr?.state === "draft" || pr?.state === "closed" || !!task.started_at) return "in_progress";
  return "todo";
}

/** Phase totals over a list of tasks, keyed by every {@link TaskPhase} so a
 *  caller never has to guard a missing key. `prOf` and `gitOf` look up the
 *  live snapshots for one task id, same contract as {@link taskPhase}'s
 *  second and third arguments. */
export function phaseCounts(
  tasks: readonly Task[],
  prOf: (taskId: string) => PrStatus | null | undefined,
  gitOf: (taskId: string) => TaskGitState | null | undefined,
): Record<TaskPhase, number> {
  const counts: Record<TaskPhase, number> = { todo: 0, in_progress: 0, in_review: 0, done: 0 };
  for (const task of tasks) {
    counts[taskPhase(task, prOf(task.id), gitOf(task.id))]++;
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
