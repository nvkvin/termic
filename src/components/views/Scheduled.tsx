// The Scheduled view (GH #300): every recurring schedule, what it does, when
// it runs next and what its last run produced. Each schedule is a parent task
// (`Task.schedule`); its runs are tasks in the parent's sidebar group.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useProfiles } from "@/store/profiles";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { cn } from "@/lib/utils";
import { CalendarClock, ChevronDown, ChevronRight, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { deleteSchedule, runScheduleNow, updateSchedule } from "@/lib/schedules/runner";
import { openReport } from "@/lib/schedules/watcher";
import { cadenceText, nextRun, outcomeText, slotText } from "@/lib/schedules/display";
import { lastEntry } from "@/lib/schedules/history";
import { reportFolder } from "@/lib/schedules/runSpec";
import type { ScheduleRun, Task } from "@/lib/types";

export function ScheduledView() {
  const { t, i18n } = useTranslation("chrome");
  const tasks = useApp(s => s.tasks);
  const profilesExist = useProfiles(s => s.current !== null);
  const parents = useMemo(
    () => tasks.filter(w => w.schedule && !w.archived).sort((a, b) => a.schedule!.name.localeCompare(b.schedule!.name)),
    [tasks],
  );
  const openNew = () => useUI.getState().openScheduleDialog({});

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="scheduled-root">
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border-soft)] px-6 py-3">
        <CalendarClock className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
        <span className="text-[13.5px] font-medium text-[var(--color-fg)]">{t("scheduled.title")}</span>
        <button
          type="button"
          data-testid="schedule-new"
          onClick={openNew}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-[var(--color-fg-dim)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("scheduled.newSchedule")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4" data-testid="scheduled-list">
        <div className="mx-auto max-w-3xl">
          <p className="mb-3 px-3 text-[12px] leading-snug text-[var(--color-fg-faint)]" data-testid="scheduled-ceiling">
            {t("scheduled.ceiling")}
            {profilesExist && <> {t("scheduled.ceilingProfile")}</>}
          </p>
          {parents.length === 0 ? (
            <div className="px-3 py-8">
              <p className="text-[13.5px] text-[var(--color-fg-dim)]">{t("scheduled.empty")}</p>
              <p className="mt-1 text-[12.5px] leading-snug text-[var(--color-fg-faint)]">{t("scheduled.emptyHint")}</p>
            </div>
          ) : parents.map(p => <ScheduleRow key={p.id} parent={p} lang={i18n.language} />)}
        </div>
      </div>
    </div>
  );
}

function ScheduleRow({ parent, lang }: { parent: Task; lang: string }) {
  const { t } = useTranslation("chrome");
  const project = useApp(s => s.projects.find(x => x.id === parent.project_id));
  const agents = useApp(s => s.agents);
  const [open, setOpen] = useState(false);
  const s = parent.schedule!;
  const now = Date.now();
  const next = nextRun(s, now);
  const last = lastEntry(s.history);
  const iconId = resolveIconId(parent.cli, agents);

  const runNow = async () => {
    const r = await runScheduleNow(parent.id);
    const ui = useUI.getState();
    if (r.kind === "busy") ui.pushToast(t("scheduled.runNowBusy", { name: s.name }), "info");
    else if (r.kind === "started") ui.pushToast(t("scheduled.runNowStarted", { name: s.name }), "info");
  };
  const remove = async () => {
    const res = await useUI.getState().askConfirm({
      title: t("scheduled.deleteTitle", { name: s.name }),
      message: t("scheduled.deleteMessage", { folder: reportFolder(s.slug) }),
      confirmLabel: t("scheduled.deleteConfirm"),
      destructive: true,
      checkbox: { label: t("scheduled.deleteTasks"), defaultValue: false },
    });
    if (res.confirmed) await deleteSchedule(parent.id, { archiveTasks: res.checked, deleteReports: res.checked });
  };

  return (
    <div
      data-testid={`schedule-row-${parent.id}`}
      data-schedule-enabled={s.enabled ? "true" : "false"}
      className="mb-1 rounded-md px-3 py-2 hover:bg-[var(--color-hover)]"
    >
      <div className="flex items-center gap-3 text-[13px]">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-faint)]")}>
          <CliIcon cli={iconId} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium text-[var(--color-fg)]" data-testid={`schedule-name-${parent.id}`}>{s.name}</span>
            <span className="shrink-0 truncate text-[12px] text-[var(--color-fg-faint)]">{project?.name ?? ""}</span>
          </div>
          <div className="flex min-w-0 items-baseline gap-2 text-[12px] text-[var(--color-fg-dim)]">
            <span data-testid={`schedule-cadence-${parent.id}`}>{cadenceText(s.cadence, t, lang)}</span>
            <span className="text-[var(--color-fg-faint)]">·</span>
            <span data-testid={`schedule-next-${parent.id}`}>
              {next == null ? t("scheduled.paused") : t("scheduled.next", { when: slotText(next, now, lang) })}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-2 text-[12px]">
            <span className="shrink-0 text-[var(--color-fg-faint)]">{t("scheduled.lastRun")}</span>
            <span data-testid={`schedule-last-${parent.id}`} data-outcome={last?.outcome ?? "none"} className="min-w-0 truncate">
              {last ? <EntryText parentId={parent.id} entry={last} t={t} now={now} lang={lang} /> : (
                <span className="text-[var(--color-fg-faint)]">{t("scheduled.noRuns")}</span>
              )}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            value={s.enabled}
            label={t("scheduled.enabledTip")}
            testId={`schedule-toggle-${parent.id}`}
            onChange={v => { void updateSchedule(parent.id, { enabled: v }); }}
          />
          <IconButton testId={`schedule-run-now-${parent.id}`} label={t("scheduled.runNow")} onClick={() => { void runNow(); }}>
            <Play className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            testId={`schedule-edit-${parent.id}`}
            label={t("scheduled.edit")}
            onClick={() => useUI.getState().openScheduleDialog({ parentTaskId: parent.id, edit: true })}
          >
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton testId={`schedule-delete-${parent.id}`} label={t("scheduled.delete")} danger onClick={() => { void remove(); }}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>
      {s.history.length > 0 && (
        <button
          type="button"
          data-testid={`schedule-history-toggle-${parent.id}`}
          onClick={() => setOpen(o => !o)}
          className="mt-1 ml-7 flex items-center gap-1 text-[11.5px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {open ? t("scheduled.hideHistory") : t("scheduled.history")}
        </button>
      )}
      {open && (
        <ul className="mt-1 ml-7 flex flex-col gap-0.5" data-testid={`schedule-history-${parent.id}`}>
          {[...s.history].reverse().map((e, i) => (
            <li key={`${e.slot}-${i}`} data-outcome={e.outcome} className="flex min-w-0 items-baseline gap-2 text-[12px]">
              <span className="w-24 shrink-0 tabular-nums text-[var(--color-fg-faint)]">{slotText(e.slot, now, lang)}</span>
              <span className="min-w-0 truncate"><EntryText parentId={parent.id} entry={e} t={t} now={now} lang={lang} /></span>
              {e.manual && <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{t("scheduled.manual")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An entry's text, as a link to its report when there is one to open. */
function EntryText({ parentId, entry, t, now, lang }: {
  parentId: string; entry: ScheduleRun; t: TFunction; now: number; lang: string;
}) {
  const text = outcomeText(entry, t, now, lang);
  const tone = entry.outcome === "failed" ? "text-[var(--color-err)]"
    : entry.outcome === "needs_input" ? "text-[var(--color-warn)]"
    : entry.outcome === "missed" || entry.outcome === "skipped" || entry.outcome === "no_report" ? "text-[var(--color-fg-dim)]"
    : "text-[var(--color-fg)]";
  if (entry.outcome === "fired" && entry.report && !entry.report_gone) {
    return (
      <button
        type="button"
        data-testid="schedule-report-link"
        title={t("scheduled.openReport")}
        onClick={() => openReport(parentId, entry)}
        className="truncate text-left text-[var(--color-palette-blue)] hover:underline"
      >
        {text}
      </button>
    );
  }
  if (entry.run_task_id && (entry.outcome === "running" || entry.outcome === "needs_input")) {
    const runId = entry.run_task_id;
    return (
      <button
        type="button"
        title={t("scheduled.openRun")}
        onClick={() => useApp.getState().setActiveTask(runId)}
        className={cn("truncate text-left hover:underline", tone)}
      >
        {text}
      </button>
    );
  }
  return <span className={tone}>{text}</span>;
}

function IconButton({ children, label, onClick, testId, danger }: {
  children: React.ReactNode; label: string; onClick: () => void; testId: string; danger?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "rounded p-1.5 text-[var(--color-fg-dim)] transition-colors hover:bg-[var(--color-bg-3)]",
        danger ? "hover:text-[var(--color-err)]" : "hover:text-[var(--color-fg)]",
      )}
    >
      {children}
    </button>
  );
}

/** A compact on/off switch: the Settings toggle's track and knob without its
 *  label block. Opacity and position move, never a themed border colour (see
 *  docs/gotchas.md, `transition-colors` in WKWebView). */
function Switch({ value, onChange, label, testId }: {
  value: boolean; onChange: (v: boolean) => void; label: string; testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={() => onChange(!value)}
      className="relative mr-1 inline-block h-[18px] w-8 shrink-0 rounded-full p-0"
      style={{ background: value ? "var(--color-accent)" : "var(--color-bg-3)" }}
    >
      <span
        className="absolute top-[2px] h-[14px] w-[14px] rounded-full"
        style={{
          left: value ? 16 : 2,
          background: value ? "var(--color-accent-fg)" : "var(--color-fg-dim)",
          transition: "left 150ms",
        }}
      />
    </button>
  );
}
