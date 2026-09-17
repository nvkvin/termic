// Park a task: "I have deliberately put this down", with an optional
// free-text reason.
//
// The ONE hand-set phase input in the app, and it is allowed to be one because
// it has no live twin: a park leaves no trace in git, in the forge or in any
// process, so there is nothing for it to drift from. It also clears itself,
// which is what keeps a hand-set value honest: the next prompt into any
// terminal of the task runs `markStarted`, which wipes `parked_at` and the
// reason together. See the header of src/lib/taskPhase.ts.
//
// There is deliberately no Blocked state. "Blocked on the API key" is a park
// REASON, which is what this box is for.
//
// UNPARKING has no dialog and is not routed through here: it is a single menu
// click with nothing to ask.
//
// PARK AND STOP STAY SEPARATE ACTIONS. The checkbox below fires `stopTask` as
// a second call after the park, because they answer different questions: stop
// is a resource action (GH #119, kill the PTYs and keep the session) and must
// never on its own claim the user put the work down. Parking usually does mean
// you want the memory back too, which is why it is offered here, and offering
// it is as far as the coupling goes.

import { useEffect, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { taskLabel } from "@/lib/taskLabel";
import { usePrefs } from "@/store/prefs";
import { Moon } from "lucide-react";

export function ParkTaskDialog() {
  const taskId = useUI(s => s.parkTaskId);
  const close = useUI(s => s.closeParkTask);
  const task = useApp(s => s.tasks.find(w => w.id === taskId) ?? null);
  const setTaskParked = useApp(s => s.setTaskParked);
  const stopTask = useApp(s => s.stopTask);
  const isMounted = useApp(s => (taskId ? s.mountedTasks.has(taskId) : false));
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);

  const open = taskId !== null;
  const [reason, setReason] = useState("");
  const [alsoStop, setAlsoStop] = useState(true);

  // Snapshot on open, same shape as ResumeOverrideDialog: this component is
  // permanently mounted from Dialogs.tsx, so nothing else resets its state.
  // Re-parking with the box pre-filled is the reason it reads the record
  // rather than starting blank.
  useEffect(() => {
    if (!open) return;
    setReason(task?.park_reason ?? "");
    setAlsoStop(true);
  }, [open, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function park() {
    if (!taskId) return;
    // Two calls, never one. `setTaskParked` records the decision; `stopTask`
    // frees the memory. Order matters only in that the park is the thing the
    // user asked for: an eviction that somehow threw must not take the park
    // with it.
    setTaskParked(taskId, true, reason);
    if (alsoStop && isMounted) stopTask(taskId);
    close();
  }

  const label = task ? taskLabel(task, useBranchAsTaskName) : "this task";

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title="Park task"
      className="max-w-lg"
    >
      <p className="mb-4 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        Marks <span className="font-mono">{label}</span> as deliberately put
        down, so it sits under Parked on the dashboard instead of looking like
        work in flight. It un-parks itself: the next prompt you send into any
        of its terminals clears this, along with the reason.
      </p>

      <label className="block text-[13.5px]">
        Reason (optional)
        <Input
          data-testid="park-reason-input"
          value={reason}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); park(); }
          }}
          placeholder="Blocked on the API key"
          className="mt-1.5"
          autoFocus
        />
        <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
          Shown on the dashboard row's tooltip. Blocked is a reason to park,
          not a state of its own.
        </span>
      </label>

      {/* Only when there is something to stop. Parking a task whose agents
          are already gone has nothing to free, and a permanently visible
          checkbox that usually does nothing is worse than no checkbox. */}
      {isMounted && (
        <label className="mt-4 flex items-start gap-2 text-[12.5px]">
          {/* Testid on the control, not the label: `Checkbox` is a styled
              button, so a wrapping label toggles nothing when clicked. */}
          <Checkbox
            checked={alsoStop}
            onChange={setAlsoStop}
            aria-label="Also stop the task"
            data-testid="park-also-stop"
            className="mt-[1px]"
          />
          <span>
            Also stop the task
            <span className="mt-0.5 block text-[11.5px] text-[var(--color-fg-faint)]">
              Ends its agents and frees their memory. The session is kept, so
              opening the task again resumes where it left off.
            </span>
          </span>
        </label>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={park} data-testid="park-confirm">
          <Moon className="h-4 w-4" /> Park
        </Button>
      </div>
    </AppDialog>
  );
}
