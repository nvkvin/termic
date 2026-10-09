import {
  archiveTask,
  dismissOverlays,
  openTask,
  requireTermicApi,
  setInputValue,
  snap,
  waitForAppShell,
  waitGone,
  waitVisible,
} from "../helpers.js";

const DIALOG = '[data-testid="task-finder"]';
const INPUT = '[data-testid="task-finder-input"]';
const STATUS = '[data-testid="task-finder-status"]';

describe("task finder dialog", () => {
  let t1 = "";
  let t2 = "";
  let t3 = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();

    t1 = await openTask("finder-alpha", true, "fakeagent");
    t2 = await openTask("finder-bravo", false, "fakeagent");
    t3 = await openTask("finder-charlie", false, "fakeagent");
  });

  after(async () => {
    await dismissOverlays();
    for (const id of [t1, t2, t3]) {
      if (id) await archiveTask(id);
    }
  });

  it("opens via shortcut and shows tasks ordered by recency", async () => {
    const isMac = process.platform === "darwin";
    // Open via ⌘O / Ctrl+O keyboard event
    await browser.execute((mac) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "o",
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
        }),
      );
    }, isMac);
    await waitVisible(DIALOG);
    await waitVisible(INPUT);

    // Ensure dialog animation settles for snapshot in unfocused test runner
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) {
        el.style.animation = "none";
        el.style.opacity = "1";
        el.style.transform = "none";
      }
    }, DIALOG);

    // Idle snapshot: all tasks listed with current task at top
    await snap("task-finder-idle.png");

    // Close with Escape
    await browser.keys(["Escape"]);
    await waitGone(DIALOG);
  });

  it("filters tasks by query and switches active task on Enter", async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().openTaskFinder();
    });
    await waitVisible(DIALOG);

    // Ensure dialog animation settles
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) {
        el.style.animation = "none";
        el.style.opacity = "1";
        el.style.transform = "none";
      }
    }, DIALOG);

    // Type filter query
    await setInputValue(INPUT, "bravo");

    // Filter snapshot showing matching tasks
    await snap("task-finder-filtered.png");

    // Select with Enter
    await browser.keys(["Enter"]);
    await waitGone(DIALOG);

    // Active task should now be t2 (bravo)
    const active = await browser.execute(() => window.__termic!.useApp.getState().activeTaskId);
    expect(active).toBe(t2);
  });

  it("shows status on the right and filters by status query", async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().openTaskFinder();
    });
    await waitVisible(DIALOG);
    await waitVisible(INPUT);
    await waitVisible(STATUS);

    // Ensure dialog animation settles
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) {
        el.style.animation = "none";
        el.style.opacity = "1";
        el.style.transform = "none";
      }
    }, DIALOG);

    // Search by status query
    await setInputValue(INPUT, "status:not-started");
    await snap("task-finder-status-filtered.png");

    // Close with Escape
    await browser.keys(["Escape"]);
    await waitGone(DIALOG);
  });
});
