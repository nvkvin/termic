// The webview half of `termic schedule list|show|set|run|delete`: recurring
// schedules over the CLI and MCP control planes.
//
// The server resolves the task; everything about schedules runs through here
// because the runner (lib/schedules/runner.ts) owns the in-memory clock,
// in-flight overlap locks, and reactive store synchronization.

import { useApp } from "@/store/app";
import {
  createSchedule,
  deleteSchedule,
  runScheduleNow,
  updateSchedule,
} from "@/lib/schedules/runner";
import { nextRun } from "@/lib/schedules/display";
import { lastEntry } from "@/lib/schedules/history";
import {
  DEFAULT_KEEP_RUNS,
  DEFAULT_REPORT_DAYS,
  newSchedule,
  type ScheduleInput,
} from "@/lib/schedules/record";
import type { ScheduleCadence, ScheduleRun, Task, TaskSchedule } from "@/lib/types";

export interface ScheduleCadenceWire {
  kind: string;
  time: string;
  weekday?: number;
}

export interface ScheduleSummaryWire {
  task_id: string;
  task_name: string;
  project_id: string;
  project_name: string;
  name: string;
  slug: string;
  enabled: boolean;
  cadence: ScheduleCadenceWire;
  prompt?: string;
  prompt_id?: string;
  next_run?: number;
  last_slot?: number;
  last_outcome?: string;
  keep_runs: number;
  report_days?: number;
  catch_up: boolean;
}

export interface ScheduleRunWire {
  slot: number;
  outcome: string;
  run_task_id?: string;
  report?: string;
  title?: string;
  count?: number;
  error?: string;
  manual?: boolean;
  report_gone?: boolean;
}

export interface ScheduleParams {
  op: "list" | "show" | "set" | "run" | "delete";
  taskId?: string;
  projectId?: string;
  name?: string;
  cadence?: ScheduleCadenceWire;
  prompt?: string;
  promptRef?: string;
  keepRuns?: number;
  reportDays?: number | null;
  catchUp?: boolean;
  enabled?: boolean;
  deleteReports?: boolean;
  archiveTasks?: boolean;
}

function toSummaryWire(
  task: Task,
  s: TaskSchedule,
  projectName: string,
  now: number,
): ScheduleSummaryWire {
  const last = lastEntry(s.history);
  const next = nextRun(s, now);
  return {
    task_id: task.id,
    task_name: task.name,
    project_id: task.project_id,
    project_name: projectName,
    name: s.name,
    slug: s.slug,
    enabled: s.enabled,
    cadence: {
      kind: s.cadence.kind,
      time: s.cadence.time,
      ...(s.cadence.kind === "weekly" && s.cadence.weekday !== undefined
        ? { weekday: s.cadence.weekday }
        : {}),
    },
    ...(s.prompt ? { prompt: s.prompt } : {}),
    ...(s.prompt_id ? { prompt_id: s.prompt_id } : {}),
    ...(next != null ? { next_run: next } : {}),
    ...(s.last_slot != null ? { last_slot: s.last_slot } : {}),
    ...(last ? { last_outcome: last.outcome } : {}),
    keep_runs: s.keep_runs,
    ...(s.report_days !== null && s.report_days !== undefined
      ? { report_days: s.report_days }
      : {}),
    catch_up: s.catch_up,
  };
}

function toRunWire(r: ScheduleRun): ScheduleRunWire {
  return {
    slot: r.slot,
    outcome: r.outcome,
    ...(r.run_task_id ? { run_task_id: r.run_task_id } : {}),
    ...(r.report ? { report: r.report } : {}),
    ...(r.title ? { title: r.title } : {}),
    ...(r.count !== undefined ? { count: r.count } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.manual ? { manual: r.manual } : {}),
    ...(r.report_gone ? { report_gone: r.report_gone } : {}),
  };
}

function normalizeCadence(wire: ScheduleCadenceWire): ScheduleCadence {
  const kind = wire.kind.toLowerCase();
  if (kind !== "daily" && kind !== "weekdays" && kind !== "weekly") {
    throw new Error(`cadence kind must be daily, weekdays, or weekly, got "${wire.kind}"`);
  }
  const time = wire.time.trim();
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
    throw new Error(`time must be in HH:MM 24-hour format, got "${time}"`);
  }
  if (kind === "weekly") {
    const weekday = wire.weekday ?? 1;
    if (weekday < 0 || weekday > 6) {
      throw new Error(`weekly schedule requires weekday between 0 (Sunday) and 6 (Saturday), got ${weekday}`);
    }
    return { kind, time, weekday };
  }
  return { kind, time };
}

export async function scheduleHandler(raw: unknown): Promise<unknown> {
  const params = (raw ?? {}) as ScheduleParams;
  const s = useApp.getState();
  const now = Date.now();
  const projectsById = new Map(s.projects.map(p => [p.id, p.name]));

  if (params.op === "list") {
    let parents = s.tasks.filter(t => t.schedule && !t.archived);
    if (params.projectId) {
      parents = parents.filter(t => t.project_id === params.projectId);
    }
    parents.sort((a, b) => a.schedule!.name.localeCompare(b.schedule!.name));
    const summaries = parents.map(p =>
      toSummaryWire(p, p.schedule!, projectsById.get(p.project_id) ?? "", now),
    );
    return { schedules: summaries };
  }

  const taskId = params.taskId;
  if (!taskId) throw new Error("taskId is required");
  const task = s.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`no task with id "${taskId}"`);
  if (task.archived) throw new Error(`task "${task.name}" is archived`);

  if (params.op === "show") {
    if (!task.schedule) throw new Error(`task "${task.name}" has no schedule`);
    const sched = task.schedule;
    const summary = toSummaryWire(
      task,
      sched,
      projectsById.get(task.project_id) ?? "",
      now,
    );
    const history = sched.history.map(toRunWire);
    return { schedule: summary, history };
  }

  if (params.op === "run") {
    if (!task.schedule) throw new Error(`task "${task.name}" has no schedule`);
    const res = await runScheduleNow(task.id, now);
    if (res.kind === "started") {
      return { run_result: { kind: "started", run_task_id: res.runId } };
    }
    if (res.kind === "busy") {
      return { run_result: { kind: "busy" } };
    }
    return { run_result: { kind: "failed", error: res.error } };
  }

  if (params.op === "delete") {
    if (!task.schedule) throw new Error(`task "${task.name}" has no schedule`);
    await deleteSchedule(task.id, {
      deleteReports: !!params.deleteReports || !!params.archiveTasks,
      archiveTasks: !!params.archiveTasks,
    });
    return { deleted: true };
  }

  if (params.op === "set") {
    // Docker check: Seatbelt and uncaged tasks only (docs/sandbox.md).
    if (task.docker_sandbox_enabled) {
      throw new Error("cannot schedule a Docker task (Seatbelt and uncaged tasks only)");
    }

    if (task.schedule) {
      const patch: Partial<ScheduleInput> & { enabled?: boolean } = {};
      if (params.name !== undefined) patch.name = params.name.trim();
      if (params.cadence !== undefined) patch.cadence = normalizeCadence(params.cadence);
      if (params.prompt !== undefined) patch.prompt = params.prompt;
      if (params.promptRef !== undefined) patch.prompt_id = params.promptRef;
      if (params.keepRuns !== undefined) patch.keep_runs = params.keepRuns;
      if (params.reportDays !== undefined) patch.report_days = params.reportDays;
      if (params.catchUp !== undefined) patch.catch_up = params.catchUp;
      if (params.enabled !== undefined) patch.enabled = params.enabled;

      const next = await updateSchedule(task.id, patch, now);
      const updated = useApp.getState().tasks.find(t => t.id === taskId);
      const sched = next ?? updated?.schedule;
      if (!sched) throw new Error("failed to update schedule");
      return {
        schedule: toSummaryWire(
          updated ?? task,
          sched,
          projectsById.get(task.project_id) ?? "",
          now,
        ),
      };
    }

    // Creating a schedule on an existing task.
    if (!params.cadence) {
      throw new Error("cadence is required when creating a schedule");
    }
    const cadence = normalizeCadence(params.cadence);
    const input: ScheduleInput = {
      name: (params.name && params.name.trim()) || task.name,
      cadence,
      prompt: params.prompt,
      prompt_id: params.promptRef,
      keep_runs: params.keepRuns ?? DEFAULT_KEEP_RUNS,
      report_days: params.reportDays !== undefined ? params.reportDays : DEFAULT_REPORT_DAYS,
      catch_up: params.catchUp ?? false,
    };
    await createSchedule({ projectId: task.project_id, parentTaskId: task.id, input }, now);

    if (params.enabled === false) {
      await updateSchedule(task.id, { enabled: false }, now);
    }

    let updated = useApp.getState().tasks.find(t => t.id === taskId);
    if (!updated?.schedule) {
      const all = useApp.getState().tasks;
      const takenSlugs = all
        .filter(t => t.project_id === task.project_id && t.schedule)
        .map(t => t.schedule!.slug);
      const sched = newSchedule(input, now, takenSlugs);
      if (params.enabled === false) sched.enabled = false;
      useApp.getState().setTaskSchedule(taskId, sched);
      updated = useApp.getState().tasks.find(t => t.id === taskId);
    }
    if (!updated?.schedule) throw new Error("failed to create schedule");
    return {
      schedule: toSummaryWire(
        updated,
        updated.schedule,
        projectsById.get(task.project_id) ?? "",
        now,
      ),
    };
  }

  throw new Error(`unknown schedule operation "${params.op}"`);
}
