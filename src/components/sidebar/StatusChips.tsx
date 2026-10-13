// The sidebar's status chips (docs/ui.md "The sidebar's status chips"): how
// many tasks are in action, and where each of them is (working, waiting on
// you, in review, settled), under the filter bar.
// A chip is a shortcut into the query, not a second filter: clicking it
// toggles `status:<column>` in the sidebar's query text, so the bar shows
// what it did and the tree is still the only list of tasks. Drawn only while
// the opt-in STATUS section is off: with it on, the section lists the same
// buckets and the chips would say it twice.
//
// Counts are PER TASK, in the board's own column (useTaskQuery's column
// map, `boardColumnFromFacts`), under the rest of the sidebar's query: a
// chip reads how many of the tasks the bar lets through sit in its column,
// which is what clicking it leaves in the tree, plus the open task the tree
// always keeps. Turning one chip on does not zero the others.
//
// Rendering discipline (bear traps 5 and 8): its own memoized component, so
// a count moving re-renders the chips and not the Sidebar body. The columns
// come from per-task status facts (never `tabs`), so an output stamp or a
// live title re-renders nothing here.

import { Fragment, memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Bell, Check, GitPullRequest } from "lucide-react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { useTaskQuery } from "@/hooks/useTaskQuery";
import { Spinner } from "@/components/ui/Spinner";
import { Tip } from "@/components/ui/Tooltip";
import { boardClauseState, parseBoardQuery, setBoardClause, stripBoardKey, toggleBoardClause } from "@/lib/boardFilter";
import { STATUS_MARK_COLOR } from "@/lib/sidebarStatus";
import type { BoardStateColumn } from "@/lib/taskBoardState";
import type { WorkStatePrefs } from "@/lib/taskWorkState";
import { cn } from "@/lib/utils";

/** A total and its parts. "Tasks in action" counts every task with an open
 *  agent tab (is:open), and the four chips after the rule are the
 *  board columns those tasks sit in, in the order a task moves through them:
 *  the agent works, it stops to ask you something, the result goes to
 *  review, or it is settled.
 *
 *  That sum is the rule the row is built on, and why there is no Done chip.
 *  Done (the unread dot) is not a column: it cuts across them, so a task
 *  that finished unread read 1 on Done and 1 again on Settled, and with
 *  Settled left out instead the row read 1, 0, 0, 0, 0 with nothing saying
 *  where the one task was. `status:done` still works typed and from the
 *  bar's menu, and the title bar's waiting pill counts the unread ones.
 *
 *  Every chip is always drawn in a fixed slot, so position does the work
 *  that sorting by urgency was for. */
const COLUMN_CHIPS = ["working", "attention", "review", "settled"] as const satisfies readonly BoardStateColumn[];
type ColumnChip = (typeof COLUMN_CHIPS)[number];
const STATUS_CHIPS = ["action", ...COLUMN_CHIPS] as const;
type StatusChip = (typeof STATUS_CHIPS)[number];
const isColumnChip = (c: StatusChip): c is ColumnChip => (COLUMN_CHIPS as readonly string[]).includes(c);

/** Literal keys, so usedKeys.test.ts can see them. */
function chipLabel(chip: StatusChip, t: (k: string) => string): string {
  switch (chip) {
    case "action": return t("statusChips.action");
    case "attention": return t("statusChips.attention");
    case "working": return t("statusChips.working");
    case "review": return t("statusChips.review");
    case "settled": return t("statusChips.settled");
  }
}

// Colours from STATUS_MARK_COLOR, which the status section's bucket headers
// share. The PR glyph is the theme's fg, not a PR-state colour: the column
// means "has a PR", and green read as "checks passed".
//
// An EMPTY chip draws its glyph in the chip's own faint text colour and holds
// the spinner still: a coloured bell or a turning ring beside a 0 would claim
// something is waiting or running when nothing is.
//
// The spinner turns only while the chip COUNTS something, which is not the
// same as not being empty: a chip whose clause is in the query stays live at
// 0 (it is how the clause comes back out), and it used to keep turning there,
// beside "0 of 4 tasks".
function chipIcon(chip: StatusChip, empty: boolean, count: number): React.ReactNode {
  const color = empty
    ? undefined
    : chip === "action" ? "var(--color-accent)" : STATUS_MARK_COLOR[chip];
  switch (chip) {
    case "action": return <Activity className="h-3 w-3" style={{ color }} strokeWidth={2.2} />;
    case "attention": return <Bell className="h-3 w-3" style={{ color }} strokeWidth={2.5} />;
    case "working": return <span style={{ color }}><Spinner size={10} still={empty || count === 0} /></span>;
    case "review": return <GitPullRequest className="h-3 w-3" style={{ color }} />;
    case "settled": return <Check className="h-3 w-3" style={{ color }} strokeWidth={2.5} />;
  }
}

export const StatusChips = memo(function StatusChips() {
  const { t } = useTranslation("sidebar");
  const projects = useApp(s => s.projects);
  const tasks = useApp(s => s.tasks);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const workPrefs: WorkStatePrefs = useMemo(
    () => ({ settledHighlight, workingIndicator, attentionIndicator }),
    [settledHighlight, workingIndicator, attentionIndicator],
  );
  const text = useUI(s => s.sidebarQuery);
  const setText = useUI(s => s.setSidebarQuery);
  // What the tree can list: unarchived, in a project of this profile.
  const live = useMemo(() => {
    const ids = new Set(projects.map(p => p.id));
    return tasks.filter(w => !w.archived && ids.has(w.project_id));
  }, [tasks, projects]);
  const { query, columnOf, columnCount, actionCount } = useTaskQuery({ text, menuOpen: false, live, workPrefs, alwaysColumns: true });
  const action = useMemo(() => actionCount(), [actionCount]);
  const counts = useMemo(
    () => Object.fromEntries(STATUS_CHIPS.map(c => [
      c,
      isColumnChip(c) ? columnCount(c) : action.shown,
    ])) as Record<StatusChip, number>,
    [columnCount, action],
  );
  // Whether a chip is EMPTY goes by the UNFILTERED column, so typing in the
  // bar never disables a chip: under a query a live one can read 0.
  const totals = useMemo(() => {
    const n: Record<string, number> = {};
    for (const c of columnOf.values()) n[c] = (n[c] ?? 0) + 1;
    n.action = action.total;
    return n;
  }, [columnOf, action]);

  // Every chip is ALWAYS drawn. They used to come and go with their
  // counts, so the row appeared when the first agent started working and
  // vanished when the last one stopped, and the whole project tree moved up
  // and down under the pointer each time. An empty chip is drawn disabled
  // instead, unless the query holds its clause: then it stays live, because
  // it is how that clause comes back out.
  return (
    // One line at any sidebar width: a chip is its glyph and count, and its
    // name lives in the tooltip and the accessible label.
    <div data-testid="status-chips" className="no-scrollbar flex min-w-0 flex-nowrap gap-1 overflow-x-auto">
      {STATUS_CHIPS.map(c => {
        const isAction = c === "action";
        const clause = isAction
          ? boardClauseState(query, "is", "open")
          : boardClauseState(query, "status", c);
        const on = clause === "include";
        const empty = (totals[c] ?? 0) === 0 && clause === null;
        const tip = empty
          ? t("statusChips.tipEmpty", { label: chipLabel(c, t) })
          : isAction
            ? t(on ? "statusChips.tipActiveAction" : "statusChips.tipAction", { label: chipLabel(c, t) })
            : t(on ? "statusChips.tipActive" : "statusChips.tip", { status: c, label: chipLabel(c, t) });
        return (
          <Fragment key={c}>
          <Tip content={tip} side="bottom">
            <button
              type="button"
              data-status-chip={c}
              data-empty={empty || undefined}
              aria-pressed={on}
              // aria-disabled, not `disabled`: a disabled button swallows the
              // hover that shows the tooltip, and the tooltip is the only
              // place the chip's name is written.
              aria-disabled={empty || undefined}
              aria-label={`${chipLabel(c, t)} ${counts[c]}`}
              onClick={() => {
                if (empty) return;
                const curText = useUI.getState().sidebarQuery;
                if (isAction) {
                  if (on) {
                    setText(setBoardClause(curText, "is", "open", null));
                  } else {
                    setText(setBoardClause(stripBoardKey(curText, "status"), "is", "open", "include"));
                  }
                } else {
                  const baseText = boardClauseState(parseBoardQuery(curText), "is", "open") === "include"
                    ? setBoardClause(curText, "is", "open", null)
                    : curText;
                  setText(toggleBoardClause(baseText, "status", c));
                }
              }}
              className={cn(
                "flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11.5px] tabular-nums transition-colors",
                on
                  ? "border-[var(--color-accent)] text-[var(--color-fg)]"
                  : empty
                    ? "cursor-default border-[var(--color-border-soft)] text-[var(--color-fg-faint)] opacity-60"
                    : "border-[var(--color-border-soft)] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
              )}
              style={on ? { backgroundColor: "color-mix(in srgb, var(--color-accent) 14%, transparent)" } : undefined}
            >
              {chipIcon(c, empty, counts[c])}
              <span data-testid="status-chip-count">{counts[c]}</span>
            </button>
          </Tip>
          {/* The rule between the total and its parts: what is left of it
              adds up to what is right of it. */}
          {isAction && <span aria-hidden data-testid="status-chips-rule" className="mx-0.5 h-3 w-px shrink-0 self-center bg-[var(--color-border)]" />}
          </Fragment>
        );
      })}
    </div>
  );
});
