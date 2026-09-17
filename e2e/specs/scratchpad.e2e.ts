import { rmSync } from "node:fs";
import path from "node:path";
import {
  archiveTask, cliRpc, ensureActiveTask, openTask, requireTermicApi, snap, waitForAppShell, waitVisible,
} from "../helpers";

/** The seeded repo every spec shares (scripts/e2e-seed.mjs). */
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

// Scratchpads (GH #244): Sublime-style untitled buffers scoped to one task.
//
// The rule everything here checks: a pad is an unsaved buffer that happens to
// survive restarts. ⌘S does NOT write to the scratch store, it PROMOTES the
// pad into the project; closing one asks; Discard is the only thing that
// deletes it.

/** The task's scratch tabs, straight from the store. */
const pads = (taskId: string) =>
  browser.execute(
    (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])
      .filter((t: any) => t.type === "scratch")
      .map((t: any) => ({ id: t.id, scratchId: t.scratchId, title: t.title, dirty: t.dirty, type: t.type })),
    taskId,
  );

const tabById = (taskId: string, tabId: string) =>
  browser.execute(
    (id, tid) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.id === tid),
    taskId, tabId,
  );

/** Type into the pad's CodeMirror through the view API the e2e build exposes.
 *  Synthetic key events don't route to a contenteditable reliably in
 *  WKWebView, so the editor's own API is the honest input path here. */
async function typeInPad(text: string) {
  await browser.execute((t) => {
    const el = document.querySelector(".cm-editor") as unknown as { __cmView?: any };
    const view = el?.__cmView;
    if (!view) throw new Error("CodeMirror e2e hook missing (build with make e2e)");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
  }, text);
}

/** Click a button in the dialog whose text contains `title`. Scoped to that
 *  dialog: dialogs stack, and a bare [role="dialog"] can grab a stale one. */
async function clickInDialog(title: string, testId: string) {
  await browser.waitUntil(
    () => browser.execute((t) => [...document.querySelectorAll('[role="dialog"]')]
      .some(d => (d.textContent ?? "").includes(t)), title),
    { timeout: 10_000, timeoutMsg: `dialog "${title}" never appeared` },
  );
  await browser.execute((t, sel) => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')]
      .find(d => (d.textContent ?? "").includes(t));
    (dlg!.querySelector(`[data-testid="${sel}"]`) as HTMLElement).click();
  }, title, testId);
}

describe("scratchpads", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    // The promote case writes notes/from-scratchpad.json into the shared
    // fixture repo. The seed heals TRACKED files only, by design, so an
    // untracked file left here survives into the next run and the git spec's
    // "Working tree is clean" boots red for a reason that has nothing to do
    // with git. Untracked dirt is the spec's to clean.
    rmSync(path.join(fixture, "notes"), { recursive: true, force: true });
  });

  it("opens from the + menu as an untitled, permanently-dirty tab", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-scratchpad");

    // Open the "+" menu the way ⌘T does: TabBar listens for this event, so
    // the spec does not depend on where the button sits in the strip.
    await browser.execute((id) => {
      window.dispatchEvent(new CustomEvent("termic-new-tab-menu", { detail: { taskId: id } }));
    }, taskId);
    // The "+" menu is a Radix dropdown; its rows are portalled.
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-testid="new-scratchpad"]')),
      { timeout: 10_000, timeoutMsg: "the + menu never offered Scratchpad" },
    );
    await browser.execute(() => {
      (document.querySelector('[data-testid="new-scratchpad"]') as HTMLElement).click();
    });

    await browser.waitUntil(async () => (await pads(taskId)).length === 1, {
      timeout: 10_000, timeoutMsg: "no scratchpad tab appeared",
    });
    const [pad] = await pads(taskId);
    expect(pad.title).toBe("Untitled");
    // The dot is honest: nothing has been saved anywhere the user chose.
    expect(pad.dirty).toBe(true);
    await snap("scratchpad-new.png");
  });

  it("builds its title from the buffer and sniffs the syntax", async () => {
    await ensureActiveTask(taskId);
    await browser.waitUntil(
      () => browser.execute(() => !!(document.querySelector(".cm-editor") as any)?.__cmView),
      { timeout: 10_000, timeoutMsg: "the pad's editor never mounted" },
    );
    await typeInPad("# Fix\n\nthe resume race\n- then ship it");

    // Debounced (~500ms) and bailed when unchanged — hence a condition, not a
    // sleep. Several lines are folded in until the cap: a jotted note's first
    // line is routinely one word, and a pill reading "Fix" would not tell two
    // pads apart. Blank lines vanish and the heading/bullet marks are stripped
    // per line, because a pill can least afford the punctuation.
    await browser.waitUntil(
      async () => (await pads(taskId))[0]?.title === "Fix the resume race then ship it",
      { timeout: 10_000, timeoutMsg: "the title never followed the buffer" },
    );

    // Replace the buffer with JSON. With no path to go on, the content
    // sniffer is the only thing that CAN name the syntax, and the button is
    // where the user sees its answer. (The title honestly becomes "{" here —
    // that is the first line with anything on it.)
    await typeInPad('{\n  "fix": "the resume race",\n  "then": "ship it"\n}');
    await browser.waitUntil(
      () => browser.execute((id) => (
        document.querySelector(`[data-task-id="${id}"] [data-testid="syntax-button"]`)?.textContent ?? ""
      ).toUpperCase().includes("JSON"), taskId),
      { timeout: 10_000, timeoutMsg: "the syntax button never named JSON" },
    );
  });

  it("takes a manual syntax pick and persists it in the index", async () => {
    await ensureActiveTask(taskId);
    // The picker is the ONLY way to name a pad's language when the sniffer
    // has nothing to go on, so it has to accept a scratch tab: it used to
    // filter to `type === "edit"` and silently no-op here.
    // Click until the picker is actually open, and read that from the STORE
    // rather than the DOM. A click that lands while React is mid-commit on
    // this pane is simply lost, and waiting on the dialog instead used to
    // spend the whole timeout on a picker nothing had opened. The store flag
    // is the thing the button sets, so it cannot be confused by a closing
    // palette an earlier spec file left mounted (animations are frozen while
    // the window is occluded, so those husks outlive their close).
    await browser.waitUntil(
      () => browser.execute((id) => {
        if (window.__termic!.useUI.getState().syntaxPaletteFor) return true;
        const btn = document.querySelector(
          `[data-task-id="${id}"] [data-testid="syntax-button"]`,
        ) as HTMLElement | null;
        btn?.click();
        return false;
      }, taskId),
      { timeout: 10_000, interval: 250, timeoutMsg: "the syntax button never opened the picker" },
    );
    // The list arrives with the languageExts chunk, so the rows are a beat
    // behind the dialog. Wait for the row, not for the frame around it.
    const markdownRow = '[data-testid="syntax-palette"] [data-lang="Markdown"]';
    await waitVisible(markdownRow);
    await browser.execute((sel) => {
      // Keyed by CodeMirror's registry NAME, which is also the label.
      (document.querySelector(sel) as HTMLElement).click();
    }, markdownRow);

    await browser.waitUntil(
      () => browser.execute((id) => (
        document.querySelector(`[data-task-id="${id}"] [data-testid="syntax-button"]`)?.textContent ?? ""
      ).toLowerCase().includes("markdown"), taskId),
      { timeout: 10_000, timeoutMsg: "the manual pick never reached the syntax button" },
    );

    // Picking Markdown also earns the pad the source / preview / split shell
    // a `.md` file gets: the pad has no extension, so the pick is how you say
    // "this is a document", and the toggle is most of what that buys you.
    await browser.waitUntil(
      () => browser.execute((id) => !!document.querySelector(
        `[data-task-id="${id}"] [data-testid="source-preview-shell"]`), taskId),
      { timeout: 10_000, timeoutMsg: "a markdown pad never got the preview shell" },
    );
    // The preview renders from the LIVE buffer, not from disk: there is no
    // file yet, so nothing else could feed it.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "scratch");
      app.patchTab(id, tab.id, { mdView: "preview" });
    }, taskId);
    await browser.waitUntil(
      () => browser.execute((id) => (
        document.querySelector(`[data-task-id="${id}"] [data-testid="source-preview-shell"]`) as HTMLElement | null
      )?.innerText?.includes("the resume race") ?? false, taskId),
      { timeout: 10_000, timeoutMsg: "the markdown preview never rendered the buffer" },
    );
    // Back to source, so the ⌘S case below types into a visible editor.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "scratch");
      app.patchTab(id, tab.id, { mdView: "source" });
    }, taskId);

    // Persisted in the scratch index, unlike an edit tab's session-only pick:
    // a pad has no extension to re-derive it from after a relaunch. Stored as
    // the registry NAME, which is what the index holds from now on (a pad
    // written by an older build still says "markdown"; normalizeLanguageId
    // translates it on read, see docs/tech-debt.md).
    const pad = (await pads(taskId))[0];
    await browser.waitUntil(
      async () => {
        const listed = await browser.execute(
          (id) => window.__termic!.ipc.scratchList(id), taskId,
        ) as { id: string; syntax?: string }[];
        return listed.find(r => r.id === pad.scratchId)?.syntax === "Markdown";
      },
      { timeout: 10_000, timeoutMsg: "the manual pick never reached the scratch index" },
    );
  });

  it("Cancel on close keeps both the tab and the pad", async () => {
    await ensureActiveTask(taskId);
    const [pad] = await pads(taskId);
    // The strip's × — the real close path, shared with the pane × and ⌘W.
    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"] button[title="Close tab"]`) as HTMLElement).click();
    }, pad.id);

    await clickInDialog("Close this scratchpad?", "scratch-close-cancel");
    expect((await pads(taskId)).length).toBe(1);
  });

  it("Cmd+S promotes it into the project and the tab becomes a real file", async () => {
    await ensureActiveTask(taskId);
    const [pad] = await pads(taskId);

    await browser.execute(() => {
      document.querySelector(".cm-content")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
      );
    });
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-testid="scratch-save-path"]')),
      { timeout: 10_000, timeoutMsg: "Cmd+S never opened the save picker" },
    );

    // Name it ourselves rather than trusting the prefilled slug: the point of
    // the picker is that the user chooses the place.
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="scratch-save-path"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "notes/from-scratchpad.json");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.execute(() => {
      (document.querySelector('[data-testid="scratch-save-confirm"]') as HTMLElement).click();
    });

    // The pad is gone, and the SAME tab is now an ordinary edit tab on the
    // path the user picked.
    await browser.waitUntil(async () => (await pads(taskId)).length === 0, {
      timeout: 10_000, timeoutMsg: "the pad never stopped being a pad",
    });
    const tab = await tabById(taskId, pad.id) as any;
    expect(tab.type).toBe("edit");
    expect(tab.path).toBe("notes/from-scratchpad.json");
    // The one path that ends a pad's permanent dirty state.
    expect(tab.dirty).toBe(false);

    // It is really on disk, inside the worktree, with the buffer's contents.
    const onDisk = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "notes/from-scratchpad.json"),
      taskId,
    );
    expect(onDisk).toContain("the resume race");

    // ...and git can see it, which is the whole reason pads are stored
    // outside the worktree until this moment.
    await browser.waitUntil(
      async () => {
        const status = await browser.execute(
          (id) => window.__termic!.ipc.taskGitStatus(id), taskId,
        ) as any;
        return JSON.stringify(status).includes("from-scratchpad.json");
      },
      { timeout: 10_000, timeoutMsg: "the promoted file never showed up in git status" },
    );
    await snap("scratchpad-promoted.png");
  });

  it("a bulk close asks about every pad, and Cancel spares that one", async () => {
    await ensureActiveTask(taskId);
    // Three pads, closed as a set through the tab context menu's own
    // "Close others" — the shared bulk path behind it and "Close to the
    // right". The clicked tab always survives both, so the agent tab is the
    // one right-clicked and all three pads are in the set.
    for (let i = 0; i < 3; i++) {
      await browser.execute(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "n", metaKey: true, altKey: true, bubbles: true,
        }));
      });
      await browser.waitUntil(async () => (await pads(taskId)).length === i + 1, {
        timeout: 10_000, timeoutMsg: `pad ${i + 1} never appeared`,
      });
    }
    const before = await pads(taskId);
    const agentTabId = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.type === "terminal")?.id as string,
      taskId,
    ) as string;

    // Dispatched, not gestured: a WebDriver right-click does not reach
    // Radix's onContextMenu in this WKWebView (see tabs-layout.e2e.ts).
    await browser.execute((tid) => {
      const el = document.querySelector(`[data-tab-id="${tid}"]`) as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2,
        clientX: r.left + 10, clientY: r.top + 10,
      }));
    }, agentTabId);
    await browser.waitUntil(
      () => browser.execute(() => [...document.querySelectorAll('[role="menu"]')]
        .some(m => (m as HTMLElement).innerText.includes("Close others"))),
      { timeout: 8_000, timeoutMsg: "the tab context menu never opened" },
    );
    await browser.execute(() => {
      const menu = [...document.querySelectorAll('[role="menu"]')]
        .find(m => (m as HTMLElement).innerText.includes("Close others")) as HTMLElement;
      const row = [...menu.children]
        .find(el => (el as HTMLElement).innerText?.trim().startsWith("Close others")) as HTMLElement;
      row.click();
    });

    // ONE prompt per pad, in strip order: discard, cancel, discard. A single
    // click must never decide the fate of three unsaved notes.
    await clickInDialog("Close this scratchpad?", "scratch-close-discard");
    await clickInDialog("Close this scratchpad?", "scratch-close-cancel");
    await clickInDialog("Close this scratchpad?", "scratch-close-discard");

    await browser.waitUntil(async () => (await pads(taskId)).length === 1, {
      timeout: 10_000, timeoutMsg: "the bulk close did not leave exactly the spared pad",
    });
    // Cancel spared THAT pad; the rest of the set still closed.
    expect((await pads(taskId))[0].scratchId).toBe(before[1].scratchId);
    const listed = await browser.execute(
      (id) => window.__termic!.ipc.scratchList(id), taskId,
    ) as { id: string }[];
    expect(listed.map(r => r.id)).toEqual([before[1].scratchId]);

    // Clear the survivor so the next case starts from an empty strip.
    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"] button[title="Close tab"]`) as HTMLElement).click();
    }, before[1].id);
    await clickInDialog("Close this scratchpad?", "scratch-close-discard");
    await browser.waitUntil(async () => (await pads(taskId)).length === 0, {
      timeout: 10_000, timeoutMsg: "the spared pad never closed",
    });
  });

  it("Discard on close deletes the pad for good", async () => {
    await ensureActiveTask(taskId);
    // A fresh pad, straight through the shortcut path this time.
    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "n", metaKey: true, altKey: true, bubbles: true,
      }));
    });
    await browser.waitUntil(async () => (await pads(taskId)).length === 1, {
      timeout: 10_000, timeoutMsg: "the shortcut never created a scratchpad",
    });
    const [pad] = await pads(taskId);

    await browser.execute((tid) => {
      (document.querySelector(`[data-tab-id="${tid}"] button[title="Close tab"]`) as HTMLElement).click();
    }, pad.id);
    await clickInDialog("Close this scratchpad?", "scratch-close-discard");

    await browser.waitUntil(async () => (await pads(taskId)).length === 0, {
      timeout: 10_000, timeoutMsg: "Discard never closed the tab",
    });
    // Gone from the index too, so a relaunch does not bring it back.
    const listed = await browser.execute(
      (id) => window.__termic!.ipc.scratchList(id), taskId,
    ) as any[];
    expect(listed.some(r => r.id === pad.scratchId)).toBe(false);
  });
});

// `termic scratchpad` over the real control socket: an agent writes notes the human
// reads. The pad opens without taking focus, and a write to an OPEN pad lands
// in its editor at once rather than behind it on disk.
describe("scratchpads from the CLI", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // The pad is the active tab when this is read, so the laid-out editor in
  // this task is its editor.
  const editorText = (_padTabId: string) => browser.execute((id) => {
    const ed = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
      .find((el) => el.getBoundingClientRect().width > 0) as (HTMLElement & { __cmView?: any }) | undefined;
    return ed?.__cmView?.state.doc.toString() ?? null;
  }, taskId) as Promise<string | null>;

  it("creates a titled pad without stealing focus, and lists it", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-scratchpad-cli");
    const activeBefore = await browser.execute((id) => window.__termic!.useApp.getState().activeTab[id], taskId);

    const r = await cliRpc({ cmd: "pad_new", task: taskId, title: "Findings", content: "# Findings\n" });
    expect(r.ok).toBe(true);
    expect(r.data.kind).toBe("pad");
    const padId = r.data.pads[0].id as string;
    expect(r.data.pads[0]).toMatchObject({ title: "Findings", open: true });

    await browser.waitUntil(async () => (await pads(taskId)).some((p: any) => p.scratchId === padId), {
      timeout: 10_000, timeoutMsg: "pad_new never opened a tab",
    });
    const activeAfter = await browser.execute((id) => window.__termic!.useApp.getState().activeTab[id], taskId);
    expect(activeAfter).toBe(activeBefore);

    const l = await cliRpc({ cmd: "pad_list", task: taskId });
    expect(l.data.pads.map((p: any) => p.id)).toContain(padId);
  });

  it("writes into the OPEN pad live, and reads back the human's edits", async () => {
    const [pad] = (await pads(taskId)).filter((p: any) => p.title === "Findings");
    await browser.execute((id, tid) => window.__termic!.useApp.getState().setActiveTabId(id, tid), taskId, pad.id);
    await browser.waitUntil(async () => (await editorText(pad.id)) === "# Findings\n", {
      timeout: 10_000, timeoutMsg: "the pad's editor never loaded the seeded text",
    });

    const w = await cliRpc({ cmd: "pad_write", task: taskId, pad: "findings", content: "- first result\n", append: true });
    expect(w.ok).toBe(true);
    await browser.waitUntil(async () => (await editorText(pad.id)) === "# Findings\n- first result\n", {
      timeout: 5_000, timeoutMsg: "an append to an open pad did not show in its editor",
    });
    await snap("scratchpad-cli-live-write.png");

    // The human types; a read sees it before any flush could have run.
    await browser.execute((id, t) => {
      const ed = [...document.querySelectorAll(`[data-task-id="${id}"] .cm-editor`)]
        .find((el) => el.getBoundingClientRect().width > 0) as (HTMLElement & { __cmView?: any });
      const view = ed.__cmView;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } });
    }, taskId, "# Findings\n- first result\n- my note\n");
    const rd = await cliRpc({ cmd: "pad_read", task: taskId, pad: pad.scratchId });
    expect(rd.data.content).toBe("# Findings\n- first result\n- my note\n");

    // A replace is on disk too, for whoever reads the closed pad later.
    await cliRpc({ cmd: "pad_write", task: taskId, pad: pad.scratchId, content: "replaced\n" });
    await browser.waitUntil(async () => (await editorText(pad.id)) === "replaced\n", {
      timeout: 5_000, timeoutMsg: "a replace did not reach the open editor",
    });
    const onDisk = await browser.execute((id, sid) => window.__termic!.ipc.scratchRead(id, sid), taskId, pad.scratchId);
    expect(onDisk).toBe("replaced\n");
  });

  it("refuses an unknown pad by name", async () => {
    const r = await cliRpc({ cmd: "pad_read", task: taskId, pad: "no-such-pad" });
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain("no-such-pad");
  });
});
