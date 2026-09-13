// The precedence table from docs/ideas/task-status.md, "The design", plus
// the decisions called out in this file's header comment.

import { describe, it, expect } from "vitest";
import {
  taskPhase, phaseCounts, taskAgeLabel, PHASE_ORDER, PHASE_LABEL, PHASE_EMPTY_LABEL,
} from "@/lib/taskPhase";
import { relativeDayLabel } from "@/lib/relativeDay";
import type { PrStatus, Task } from "@/lib/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    name: "Feature work",
    branch: "feature/example",
    base_branch: "main",
    path: "/Users/u/code/acme/tasks/acme/feature-example",
    cli: "claude",
    port: 1420,
    created: "2026-01-01T00:00:00.000Z",
    archived: false,
    ...overrides,
  };
}

function makePr(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    provider: "github",
    number: 1,
    url: "https://github.com/acme/widget/pull/1",
    title: "Example change",
    state: "open",
    checks: "none",
    review: "none",
    base: "main",
    head: "feature/example",
    ...overrides,
  };
}

describe("taskPhase", () => {
  it("backlog: no PR, never spawned, no history", () => {
    expect(taskPhase(makeTask(), null)).toBe("backlog");
  });

  it("in_progress: no PR, spawn_count > 0", () => {
    const task = makeTask({ spawn_count: 1 });
    expect(taskPhase(task, null)).toBe("in_progress");
  });

  it("in_progress: no PR, has_resumable_history true, spawn_count 0", () => {
    const task = makeTask({ spawn_count: 0, has_resumable_history: true });
    expect(taskPhase(task, null)).toBe("in_progress");
  });

  it("in_review: PR open", () => {
    const task = makeTask({ spawn_count: 1 });
    expect(taskPhase(task, makePr({ state: "open" }))).toBe("in_review");
  });

  it("done: PR merged", () => {
    const task = makeTask({ spawn_count: 1 });
    expect(taskPhase(task, makePr({ state: "merged" }))).toBe("done");
  });

  it("done: archived, regardless of PR state", () => {
    const task = makeTask({ archived: true, spawn_count: 1 });
    expect(taskPhase(task, makePr({ state: "open" }))).toBe("done");
  });

  it("archived beats merged too (same outcome, both routes to done)", () => {
    const task = makeTask({ archived: true });
    expect(taskPhase(task, makePr({ state: "merged" }))).toBe("done");
  });

  it("archived wins even when there is no PR at all", () => {
    const task = makeTask({ archived: true });
    expect(taskPhase(task, null)).toBe("done");
  });

  it("draft PR is in_progress, not in_review", () => {
    const task = makeTask();
    expect(taskPhase(task, makePr({ state: "draft" }))).toBe("in_progress");
  });

  it("closed PR is in_progress even with spawn_count 0 and no history", () => {
    const task = makeTask({ spawn_count: 0, has_resumable_history: false });
    expect(taskPhase(task, makePr({ state: "closed" }))).toBe("in_progress");
  });

  it("changes_requested review on an open PR stays in_review", () => {
    const task = makeTask();
    const pr = makePr({ state: "open", review: "changes_requested" });
    expect(taskPhase(task, pr)).toBe("in_review");
  });

  it("failing checks on an open PR stay in_review", () => {
    const task = makeTask();
    const pr = makePr({ state: "open", checks: "failing" });
    expect(taskPhase(task, pr)).toBe("in_review");
  });

  it("pr === null with spawn_count 0 and no history is backlog", () => {
    const task = makeTask({ spawn_count: 0, has_resumable_history: false });
    expect(taskPhase(task, null)).toBe("backlog");
  });

  it("pr === null with has_resumable_history is in_progress", () => {
    const task = makeTask({ spawn_count: 0, has_resumable_history: true });
    expect(taskPhase(task, null)).toBe("in_progress");
  });

  it("pr === undefined behaves exactly like pr === null", () => {
    // A failed PrLookup (cli-missing, no-remote, error, ...) also resolves
    // to a null/undefined pr, and both must fall through to the agent
    // signals rather than forcing backlog.
    const task = makeTask({ spawn_count: 1 });
    expect(taskPhase(task, undefined)).toBe(taskPhase(task, null));
    expect(taskPhase(task, undefined)).toBe("in_progress");
  });
});

describe("phaseCounts", () => {
  it("tallies a mixed list, including a task whose prOf returns null", () => {
    const tasks: Task[] = [
      makeTask({ id: "a", archived: true }),
      makeTask({ id: "b", spawn_count: 1 }),
      makeTask({ id: "c" }),
      makeTask({ id: "d", spawn_count: 2 }),
    ];
    const prById: Record<string, PrStatus | null> = {
      a: null,
      b: makePr({ state: "open" }),
      c: null,
      d: makePr({ state: "merged" }),
    };
    const counts = phaseCounts(tasks, id => prById[id] ?? null);
    expect(counts).toEqual({
      backlog: 1,
      in_progress: 0,
      in_review: 1,
      done: 2,
    });
  });

  it("returns every phase key at zero on an empty list", () => {
    expect(phaseCounts([], () => null)).toEqual({
      backlog: 0, in_progress: 0, in_review: 0, done: 0,
    });
  });
});

describe("PHASE_ORDER / PHASE_LABEL", () => {
  it("carries exactly the four phases, each with a label", () => {
    expect(PHASE_ORDER).toHaveLength(4);
    for (const phase of PHASE_ORDER) {
      expect(PHASE_LABEL[phase]).toBeTruthy();
    }
  });
});

describe("PHASE_EMPTY_LABEL", () => {
  it("covers every phase", () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_EMPTY_LABEL[phase]).toBeTruthy();
    }
  });

  it("reads as a sentence for backlog, which is why the map is explicit", () => {
    // The one entry that is NOT `"Nothing " + label.toLowerCase()`. If this
    // ever gets refactored into a template, this is the case that breaks.
    expect(PHASE_EMPTY_LABEL.backlog).toBe("Nothing in the backlog");
    expect(PHASE_EMPTY_LABEL.in_progress).toBe("Nothing in progress");
    expect(PHASE_EMPTY_LABEL.in_review).toBe("Nothing in review");
    expect(PHASE_EMPTY_LABEL.done).toBe("Nothing done");
  });

  it("uses no em dash, like every other user-visible string", () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_EMPTY_LABEL[phase]).not.toContain("—");
      expect(PHASE_LABEL[phase]).not.toContain("—");
    }
  });
});

describe("taskAgeLabel", () => {
  const NOW = new Date("2026-09-16T12:00:00.000Z").getTime();

  function isoMinutesAgo(minutes: number): string {
    return new Date(NOW - minutes * 60_000).toISOString();
  }

  function isoDaysAgo(days: number): string {
    return new Date(NOW - days * 86_400_000).toISOString();
  }

  it("undefined has no age", () => {
    expect(taskAgeLabel(undefined, NOW)).toBeNull();
  });

  it("null has no age", () => {
    expect(taskAgeLabel(null, NOW)).toBeNull();
  });

  it("an unparseable string has no age", () => {
    expect(taskAgeLabel("not-a-timestamp", NOW)).toBeNull();
  });

  it("5 minutes ago is suppressed as noise", () => {
    expect(taskAgeLabel(isoMinutesAgo(5), NOW)).toBeNull();
  });

  it("23 hours ago is still suppressed", () => {
    expect(taskAgeLabel(isoMinutesAgo(23 * 60), NOW)).toBeNull();
  });

  it("25 hours ago reads Yesterday", () => {
    expect(taskAgeLabel(isoMinutesAgo(25 * 60), NOW)).toBe("Yesterday");
  });

  it("3 days ago reads N days ago", () => {
    expect(taskAgeLabel(isoDaysAgo(3), NOW)).toBe("3 days ago");
  });

  it("22 days ago reads 3 weeks ago", () => {
    expect(taskAgeLabel(isoDaysAgo(22), NOW)).toBe("3 weeks ago");
  });

  it("40 days ago falls back to relativeDayLabel's month + year, not a hardcoded string", () => {
    const iso = isoDaysAgo(40);
    expect(taskAgeLabel(iso, NOW)).toBe(relativeDayLabel(iso, NOW));
  });
});
