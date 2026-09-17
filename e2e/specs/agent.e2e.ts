import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../wdio.conf.js";
// Agent work-state, attention and queue flows.
//
// These cases assert on the BADGE the user sees (`[data-testid="work-badge"]`
// in the tab strip and in the sidebar row), not on `tab.workState` in the
// store. The store field is an implementation detail of the detector; the
// badge is the feature. Reading the store here used to let the whole visual
// layer break silently — the spinner could stop rendering and every one of
// these tests would still pass.
//
// Submits go through `submitToAgent`, which drives xterm's own input path, so
// no spec stamps `lastInputAt` by hand any more. Terminal OUTPUT is still read
// from the store (`lastOutputAt`) — xterm paints to a WebGL canvas, so PTY
// bytes are genuinely not in the DOM.

import {
  archiveTask,
  clickByText,
  clickWhenVisible,
  cliRpc,
  ensureActiveTask,
  openTask,
  queuedCount,
  requireTermicApi,
  requireWorkBadges,
  sidebarBadge,
  snap,
  submitToAgent,
  taskViewBadge,
  waitForAgentReady,
  waitForAppShell,
  waitForText,
  waitForTextGone,
  pressEscape,
  setHooksOwnState,
  waitForWorkBadge,
  waitForWorkBadgeGone,
  workBadges,
  setWindowPresence,
} from "../helpers";

/** ms since the task's agent tab last produced PTY bytes. Not in the DOM. */
const quietFor = (taskId: string) =>
  browser.execute((id) => {
    const t = window.__termic!.useApp.getState().tabs[id][0];
    return Date.now() - (t.lastOutputAt ?? 0);
  }, taskId);

// Synthetic native-shaped events exercise the installed xterm + IME bridge
// together. This covers event routing, not macOS input-source generation.
describe("terminal IME", () => {
  let taskId: string;
  const taskName = "e2e-terminal-ime";
  before(async () => {
    await waitForAppShell();
    taskId = await openTask(taskName);
    await waitForAgentReady(taskId);
  });
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const cases: Array<{ name: string; expected: string; steps: Array<[string, string, string | null]> }> = [
    { name: "a syllable without a final consonant", expected: "가", steps: [
      ["insertText", "ㄱ", "ㄱ"], ["insertReplacementText", "가", "가"],
    ] },
    { name: "consecutive syllables with final consonants", expected: "안녕", steps: [
      ["insertText", "ㅇ", "ㅇ"], ["insertReplacementText", "아", "아"],
      ["insertReplacementText", "안", "안"], ["insertText", "안ㄴ", "ㄴ"],
      ["insertReplacementText", "안녀", "녀"], ["insertReplacementText", "안녕", "녕"],
    ] },
    { name: "a final consonant moving into the next syllable", expected: "아나", steps: [
      ["insertText", "ㅇ", "ㅇ"], ["insertReplacementText", "아", "아"],
      ["insertReplacementText", "안", "안"], ["insertReplacementText", "아나", "아나"],
    ] },
    { name: "a space between syllables", expected: "가 나", steps: [
      ["insertText", "ㄱ", "ㄱ"], ["insertReplacementText", "가", "가"],
      ["insertText", "가 ", " "], ["insertText", "가 ㄴ", "ㄴ"],
      ["insertReplacementText", "가 나", "나"],
    ] },
    { name: "Backspace removing a composing final consonant", expected: "아", steps: [
      ["insertText", "ㅇ", "ㅇ"], ["insertReplacementText", "아", "아"],
      ["insertReplacementText", "안", "안"], ["deleteContentBackward", "아", null],
    ] },
  ];

  for (const [index, { name, expected, steps }] of cases.entries()) {
    it(`preserves the preceding text when typing ${name}`, async () => {
      const prefix = `ime-${index}:`;
      await browser.execute((id, start, inputs) => {
        const ta = document.querySelector<HTMLTextAreaElement>(
          `[data-task-id="${id}"] [data-terminal-host] .xterm-helper-textarea`,
        );
        if (!ta) throw new Error("agent terminal textarea is missing");
        ta.focus();
        ta.value = start;
        ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: start, bubbles: true }));
        for (const [inputType, value, data] of inputs) {
          const space = data === " ";
          const key = { key: space ? " " : "Process", keyCode: space ? 32 : 229, bubbles: true, cancelable: true };
          ta.dispatchEvent(new KeyboardEvent("keydown", key));
          if (space) ta.dispatchEvent(new KeyboardEvent("keypress", { ...key, charCode: 32, which: 32 }));
          ta.value = start + value;
          ta.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, composed: true }));
          ta.dispatchEvent(new KeyboardEvent("keyup", key));
        }
        for (const type of ["keydown", "keyup"]) {
          ta.dispatchEvent(new KeyboardEvent(type, {
            key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true,
          }));
        }
      }, taskId, prefix, steps);
      let echo = "";
      await browser.waitUntil(async () => {
        const logs = await cliRpc({ cmd: "logs", task: taskName });
        echo = logs.data?.data ?? "";
        return echo.includes(`FAKE-AGENT echo: ime-${index}`);
      }, { timeoutMsg: "the fixture never echoed the IME input" });
      expect(echo).toContain(`FAKE-AGENT echo: ${prefix}${expected}\r\n`);
    });
  }

  it("preserves a syllable when the next insert precedes keydown and the previous keyup", async () => {
    await browser.execute((id) => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        `[data-task-id="${id}"] [data-terminal-host] .xterm-helper-textarea`,
      )!;
      ta.focus();
      const input = (inputType: string, value: string, data: string) => {
        ta.value = `ime-rollover:${value}`;
        ta.dispatchEvent(new InputEvent("input", { inputType, data, composed: true, bubbles: true }));
      };
      const key = (type: string, keyCode: number) => {
        ta.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true, cancelable: true }));
      };
      input("insertText", "", "ime-rollover:");
      input("insertText", "ㄱ", "ㄱ");
      key("keydown", 229);
      input("insertReplacementText", "가", "가");
      // The next jamo arrives before its keydown and the previous key's keyup.
      input("insertText", "가ㄴ", "ㄴ");
      key("keydown", 229);
      key("keyup", 82);
      input("insertReplacementText", "가나", "나");
      key("keyup", 83);
    }, taskId);
    await submitToAgent(taskId, "");
    await browser.waitUntil(async () => {
      const logs = await cliRpc({ cmd: "logs", task: taskName });
      return logs.data?.data?.includes("FAKE-AGENT echo: ime-rollover:가나\r\n");
    }, { timeoutMsg: "key rollover lost the preceding Korean syllable" });
  });

  for (const [index, [name, draft, committed]] of [
    ["Japanese conversion", "にほん", "日本"],
    ["Chinese conversion", "zhongwen", "中文"],
    ["accent composition", "e", "é"],
    ["emoji composition", "👩", "👩‍💻"],
    ["dictation", "hello", "hello world"],
  ].entries()) {
    it(`sends ${name} once when the final input follows compositionend`, async () => {
      const prefix = `native-${index}:`;
      await browser.execute((id, start, value) => {
        const ta = document.querySelector<HTMLTextAreaElement>(
          `[data-task-id="${id}"] [data-terminal-host] .xterm-helper-textarea`,
        )!;
        ta.focus();
        ta.value = start;
        ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: start, bubbles: true }));
        ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: value, bubbles: true }));
        ta.value = start + value;
        ta.dispatchEvent(new InputEvent("input", {
          inputType: "insertCompositionText", data: value, isComposing: true, composed: true, bubbles: true,
        }));
      }, taskId, prefix, draft);
      await browser.execute((id, start, value) => {
        const ta = document.querySelector<HTMLTextAreaElement>(
          `[data-task-id="${id}"] [data-terminal-host] .xterm-helper-textarea`,
        )!;
        ta.value = start;
        ta.dispatchEvent(new InputEvent("input", {
          inputType: "deleteCompositionText", isComposing: true, composed: true, bubbles: true,
        }));
        ta.dispatchEvent(new CompositionEvent("compositionend", { data: value, bubbles: true }));
        ta.value = start + value;
        ta.dispatchEvent(new InputEvent("input", {
          inputType: "insertFromComposition", data: value, composed: true, bubbles: true,
        }));
      }, taskId, prefix, committed);
      await submitToAgent(taskId, "");
      let echo = "";
      await browser.waitUntil(async () => {
        const logs = await cliRpc({ cmd: "logs", task: taskName });
        echo = logs.data?.data ?? "";
        return echo.includes(`FAKE-AGENT echo: ${prefix}`);
      }, { timeoutMsg: "the fixture never echoed the native composition" });
      expect(echo).toContain(`FAKE-AGENT echo: ${prefix}${committed}\r\n`);
    });
  }

  for (const paste of [false, true]) {
    it(`preserves English, spaces, accents and emoji through ${paste ? "paste" : "direct text input"}`, async () => {
      const text = `${paste ? "paste" : "direct"}:hello café 🙂`;
      if (paste) {
        await browser.execute((id, value) => {
          const ta = document.querySelector<HTMLTextAreaElement>(
            `[data-task-id="${id}"] [data-terminal-host] .xterm-helper-textarea`,
          )!;
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", value);
          ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
        }, taskId, text);
        await submitToAgent(taskId, "");
      } else {
        await submitToAgent(taskId, text);
      }
      await browser.waitUntil(async () => {
        const logs = await cliRpc({ cmd: "logs", task: taskName });
        return logs.data?.data?.includes(`FAKE-AGENT echo: ${text}\r\n`);
      }, { timeoutMsg: "ordinary terminal text was lost or duplicated" });
    });
  }
});

// Pasting an image into an agent terminal.
//
// This is the one gesture that cannot reach an agent as text: xterm.js sends
// bytes down the PTY and nothing else, and in Docker mode the agent is a
// Linux process with no route to the Mac's pasteboard, so its own clipboard
// reader finds nothing. termic writes the bytes to a file and types the path
// instead. Two halves, both covered here: the backend actually persisting a
// file (sniffing the format from the bytes, not from a claimed name), and the
// capture-phase listener on the terminal actually consuming an image paste
// while leaving an ordinary text paste alone.
describe("image paste", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];

  type Pastes = { image: boolean; text: boolean };

  /** Put the task in (or out of) Docker mode and wait for the store to agree.
   *  The paste listener reads the LIVE task on every event, so this is the
   *  only state the two cases below differ by. */
  const setDocker = async (id: string, on: boolean) => {
    await browser.execute(async (taskId, enabled) => {
      const t = window.__termic!;
      await t.ipc.taskSetDocker(taskId, enabled, [], []);
      await t.useApp.getState().loadAll();
    }, id, on);
    await browser.waitUntil(
      async () => (await browser.execute((taskId) =>
        !!window.__termic!.useApp.getState().tasks.find((t: { id: string }) => t.id === taskId)?.docker_sandbox_enabled,
      id)) === on,
      { timeoutMsg: `the task never settled to docker=${on}` },
    );
  };

  /** Fire a synthetic image paste and a synthetic text paste at the task's
   *  terminal, and report which of them was CONSUMED. That is the
   *  deterministic signal for whether the capture-phase listener stepped in:
   *  xterm paints to a canvas, so the pasted path itself is not in the DOM.
   *  The three fields are exactly what a real ClipboardEvent carries. */
  const firePastes = (id: string) => browser.execute((taskId) => {
    const host = document.querySelector(`[data-task-id="${taskId}"] [data-terminal-host]`);
    if (!host) return "no terminal host";
    const fire = (data: Record<string, unknown>) => {
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: data });
      return !host.dispatchEvent(ev);
    };
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    return {
      image: fire({ types: ["Files"], files: [file], items: [] }),
      text: fire({ types: ["text/plain"], files: [], items: [] }),
    };
  }, id) as Promise<Pastes | string>;

  it("writes a pasted image to disk and names it for its real format", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const path = await browser.execute(async (bytes) =>
      window.__termic!.ipc.clipboardImageSave(new Uint8Array(bytes as number[])), PNG) as string;
    // Under the shared clipboard dir, which Docker mode mounts read-only at
    // this same absolute path, so what gets typed resolves in both worlds.
    expect(path).toContain("/clipboard/");
    expect(path).toMatch(/\/pasted-\d+-[0-9a-f]{8}\.png$/);
  });

  it("refuses bytes that are not an image, rather than writing a fake .png", async () => {
    const err = await browser.execute(async () => {
      try {
        await window.__termic!.ipc.clipboardImageSave(new TextEncoder().encode("just some text"));
        return null;
      } catch (e) { return String(e); }
    });
    expect(err).toBeTruthy();
  });

  it("reads an image straight off the Mac clipboard for ctrl+V", async () => {
    // ctrl+V is not a paste event (it is byte 0x16 down the PTY, and the
    // gesture claude binds its own image-attach to), so there are no bytes to
    // hand over and the pasteboard is read natively. That read is the part
    // worth covering; the keystroke that triggers it is one `if`.
    //
    // This does clobber the clipboard, so whatever text was on it is put back
    // afterwards. An image cannot be restored, which is the honest cost of
    // covering a clipboard feature at all.
    const { execFileSync } = await import("node:child_process");
    const before = execFileSync("pbpaste", { encoding: "utf8" });
    const png = "/tmp/termic-e2e-clipboard.png";
    execFileSync("/usr/bin/python3", ["-c",
      `import base64,pathlib;pathlib.Path(${JSON.stringify(png)}).write_bytes(base64.b64decode(` +
      `"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))`]);
    try {
      execFileSync("osascript", ["-e", `set the clipboard to (read (POSIX file "${png}") as «class PNGf»)`]);
      const path = await browser.execute(async () => {
        try { return await window.__termic!.ipc.clipboardImageCapture(); }
        catch (e) { return "ERR " + String(e); }
      }) as string;
      expect(path).toMatch(/\/pasted-\d+-[0-9a-f]{8}\.png$/);

      // Text on the clipboard is an ordinary refusal, not a crash: the caller
      // forwards the keystroke to the agent and lets it answer for itself.
      execFileSync("osascript", ["-e", 'set the clipboard to "not an image"']);
      const err = await browser.execute(async () => {
        try { await window.__termic!.ipc.clipboardImageCapture(); return null; }
        catch (e) { return String(e); }
      });
      expect(err).toBeTruthy();
    } finally {
      execFileSync("pbcopy", { input: before });
    }
  });

  it("leaves a paste alone in a terminal that is NOT in Docker", async () => {
    // The important half. Outside a container the agent reads the Mac
    // clipboard itself and gets the real image, so stepping in would hand it
    // a file path instead - strictly worse. This task is an ordinary one, so
    // BOTH pastes must reach xterm untouched.
    taskId = await openTask("e2e-image-paste");
    await waitForAgentReady(taskId);
    // Pin the mode rather than trusting the fixture's default. A new task
    // inherits the profile's global sandbox selection, which an earlier spec
    // may have left on Docker - that is exactly how this case passed on one
    // run and failed on the next.
    await setDocker(taskId, false);
    const r = await firePastes(taskId);
    expect(typeof r).not.toBe("string");
    expect((r as Pastes).image).toBe(false);
    expect((r as Pastes).text).toBe(false);
  });

  it("consumes an image paste once the task runs in Docker, but still lets text through", async () => {
    await setDocker(taskId, true);

    const r = await firePastes(taskId);
    expect(typeof r).not.toBe("string");
    expect((r as Pastes).image).toBe(true);
    // The common paste must still reach xterm untouched, in either mode.
    // Swallowing this one would break every ordinary ⌘V in the app.
    expect((r as Pastes).text).toBe(false);
  });
});

// P0: after a real submit, termic must SHOW the agent as working. Work
// detection is gated on the tab having been submitted-to since spawn (guards
// against cold-start false positives), which is exactly why the submit goes in
// through the terminal's input path: it arms the detector the way a keystroke
// does, so this covers the arming too.
describe("agent working state", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("shows the working badge after a submit", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    taskId = await openTask("e2e-agent-working");
    await waitForAgentReady(taskId);

    await submitToAgent(taskId, "do something");

    await waitForWorkBadge(taskId, "working", {
      timeout: 10_000,
      message: "the tab never showed a working badge after a submit",
    });
    await snap("agent-working.png");
  });
});

describe("inline images", () => {
  let taskId!: string;

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("keeps IIP images visible through Pi's alternate-screen redraw", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-iip");
    await waitForAgentReady(taskId);

    const tabId = await browser.execute((id) => window.__termic!.useApp.getState().tabs[id][0].id, taskId);
    const opaquePixelCount = () => browser.execute((id) => {
      const layer = document.querySelector(`[data-terminal-host="${id}"] .xterm-image-layer`);
      if (!(layer instanceof HTMLCanvasElement) || !layer.width || !layer.height) return 0;
      const context = layer.getContext("2d");
      if (!context) return 0;
      const pixels = context.getImageData(0, 0, layer.width, layer.height).data;
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
      return count;
    }, tabId);
    await submitToAgent(taskId, "#iip");

    await browser.waitUntil(
      () => browser.execute((id) => (window.__termic!.useApp.getState().tabs[id][0].liveTitle ?? "").endsWith("iip-after"), taskId),
      { timeout: 10_000, timeoutMsg: "terminal parsing never resumed after the inline image" },
    );
    let previousOpaquePixels = 0;
    let settledFrames = 0;
    await browser.waitUntil(
      async () => {
        const opaquePixels = await opaquePixelCount();
        settledFrames = opaquePixels > 0 && opaquePixels === previousOpaquePixels ? settledFrames + 1 : 0;
        previousOpaquePixels = opaquePixels;
        return settledFrames >= 3;
      },
      { timeout: 10_000, timeoutMsg: "Pi's redraw erased the inline image after rendering settled" },
    );
    await browser.pause(500);
    expect(await opaquePixelCount()).toBeGreaterThan(0);
    await snap("inline-image.png");
  });
});

// P0: when an agent you're NOT watching finishes, termic must raise attention
// on its tab. Start an agent working, switch to another task so it's
// backgrounded (still mounted), and assert its SIDEBAR row flags completion —
// that row is the only surface a user can see it on while looking elsewhere.
describe("agent attention", () => {
  let a: string | undefined;
  let b: string | undefined;
  after(async () => {
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  it("flags a backgrounded agent's completion", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();

    a = await openTask("e2e-attn-a");
    await waitForAgentReady(a);
    await submitToAgent(a, "do something");
    await waitForWorkBadge(a, "working", {
      timeout: 10_000,
      message: "agent A never showed a working badge",
    });

    // Switch to a second task so A is backgrounded (kept mounted).
    b = await openTask("e2e-attn-b");

    await browser.waitUntil(
      async () => {
        const badge = await sidebarBadge(a!);
        return badge === "done" || badge === "attention";
      },
      {
        timeout: 15_000,
        interval: 300,
        timeoutMsg: "the backgrounded agent's sidebar row never flagged completion",
      },
    );

    await snap("agent-attention.png");
  });
});

// P1: the message queue lets you line up input while an agent is busy; it
// sends on idle. Cases: a message enqueued while working is HELD (the footer
// chip keeps counting it), then DRAINS once the agent goes idle (chip empties
// + the PTY receives it).
describe("message queue", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("holds a message while working, then drains it when idle", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    taskId = await openTask("e2e-queue");
    await waitForAgentReady(taskId);

    // Put the agent to work.
    await submitToAgent(taskId, "work");
    await waitForWorkBadge(taskId, "working", {
      timeout: 10_000,
      message: "agent never showed a working badge",
    });

    // Enqueue a message WHILE working — it must be held, not sent. Adding it
    // is a store call (the composer lives in a popover; the queue engine, not
    // the popover, is what this case is about), but the assertion is the
    // footer chip's count.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.enqueueAgentMessage(id, s.tabs[id][0].id, "queued-msg");
    }, taskId);
    await browser.waitUntil(async () => (await queuedCount(taskId!)) === 1, {
      timeout: 8_000,
      timeoutMsg: "the queue chip never counted the held message",
    });

    const before = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].lastOutputAt ?? 0,
      taskId,
    );

    // Once the agent settles to idle, the queue drains: the chip empties and
    // the PTY receives the queued line (new output — canvas, so store-read).
    await browser.waitUntil(
      async () => {
        if ((await queuedCount(taskId!)) !== 0) return false;
        const now = await browser.execute(
          (id) => window.__termic!.useApp.getState().tabs[id][0].lastOutputAt ?? 0,
          taskId,
        );
        return now !== before;
      },
      { timeout: 15_000, interval: 300, timeoutMsg: "queue never drained on idle" },
    );

    await snap("message-queue.png");
  });
});

// Scheduled queue messages (GH #300). A queue message with a "send after"
// date is saved with its tab and sent the first time that chat is open and
// idle on or after the date. Cases: scheduling through the popover persists to
// the task FILE and does not send; a future item survives the task being
// evicted and re-read from disk; an item that came due while the task was
// closed is delivered once on reopen; removing one clears it on disk; closing
// a secondary tab that holds one asks first.
describe("scheduled messages", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const DAY = 24 * 60 * 60 * 1000;
  const mainTab = (id: string) => browser.execute(
    (t) => (window.__termic!.useApp.getState().tabs[t] ?? []).find((x: any) => x.is_default)?.id as string,
    id,
  );
  // What the task FILE holds, not the store's mirror of it.
  const onDisk = (id: string, tab: string) => browser.execute(async (t, tb) => {
    const all: any[] = await window.__termic!.ipc.tasksList();
    const rec = all.find(w => w.id === t)?.persisted_tabs?.find((p: any) => p.id === tb);
    return (rec?.scheduled ?? []).map((m: any) => m.text) as string[];
  }, id, tab);
  const scheduledChip = (id: string) => browser.execute((t) => {
    const el = document.querySelector(`[data-task-id="${t}"] [data-testid="queue-button"]`) as HTMLElement | null;
    return el ? Number(el.dataset.scheduled ?? "0") : null;
  }, id);
  // Evict the task (every PTY dies), drop its in-memory tabs, re-read the
  // task files, reopen it. The tabs come back from `persisted_tabs` exactly as
  // on a relaunch, which a plain stopTask would not do: it keeps the tabs.
  const reopenFromDisk = async (id: string) => {
    await browser.execute(async (t) => {
      const app = window.__termic!.useApp;
      app.getState().stopTask(t);
      app.getState().setActiveTask(null);
      app.setState((s: any) => ({ tabs: { ...s.tabs, [t]: [] } }));
      await app.getState().loadAll();
    }, id);
    await browser.execute((t) => window.__termic!.useApp.getState().setActiveTask(t), id);
    await waitForAgentReady(id);
  };

  it("schedules from the popover: saved to the task file, not sent", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-scheduled");
    await waitForAgentReady(taskId);
    const tab = await mainTab(taskId);

    await clickWhenVisible(`[data-task-id="${taskId}"] [data-testid="queue-button"]`);
    const composer = await $('textarea[placeholder^="Add a message"]');
    await composer.waitForDisplayed({ timeout: 5_000 });
    await composer.setValue("check the release logs");
    // No date field until asked for: WebKit paints an EMPTY one as today's
    // date, which reads as already picked. Asking opens it on tomorrow.
    const dateField = () => browser.execute(() =>
      (document.querySelector('[data-testid="queue-send-after-date"]') as HTMLInputElement | null)?.value ?? null);
    expect(await dateField()).toBeNull();
    await clickWhenVisible('[data-testid="queue-send-after-pick"]');
    const tomorrow = await browser.execute(() => {
      const d = new Date(); d.setDate(d.getDate() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    expect(await dateField()).toBe(tomorrow);
    await clickWhenVisible('[data-testid="queue-send-after-7"]');
    expect(await dateField()).toBeNull();
    // The hint states the ceiling where the choice is made, and never a time.
    const hint = await $('[data-testid="queue-hint"]').getText();
    expect(hint).toMatch(/^Sends the next time this chat is open on or after /);
    await clickByText("Schedule");

    await browser.waitUntil(async () => (await scheduledChip(taskId)) === 1, {
      timeout: 5_000, timeoutMsg: "the queue chip never counted the scheduled message",
    });
    expect(await $('[data-testid="queue-item-scheduled"]').isDisplayed()).toBe(true);
    await snap("scheduled-message-popover.png");
    await pressEscape(taskId);
    expect(await onDisk(taskId, tab)).toEqual(["check the release logs"]);
  });

  it("a future item survives the task being re-read from disk, unsent", async () => {
    const tab = await mainTab(taskId);
    await reopenFromDisk(taskId);
    await browser.waitUntil(async () => (await scheduledChip(taskId)) === 1, {
      timeout: 10_000, timeoutMsg: "the scheduled message did not come back with the tab",
    });
    expect(await onDisk(taskId, tab)).toEqual(["check the release logs"]);
  });

  it("removing it from the popover clears it on disk", async () => {
    const tab = await mainTab(taskId);
    await clickWhenVisible(`[data-task-id="${taskId}"] [data-testid="queue-button"]`);
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-testid="queue-item-scheduled"]')),
      { timeout: 5_000, timeoutMsg: "the popover never listed the scheduled item" },
    );
    // The remove button only shows on hover; its handler is what is under test.
    await browser.execute(() => {
      const li = document.querySelector('[data-testid="queue-item-scheduled"]')!.closest("li")!;
      (li.querySelector('button[title="Remove"]') as HTMLElement).click();
    });
    await browser.waitUntil(async () => (await scheduledChip(taskId)) === 0, {
      timeout: 5_000, timeoutMsg: "removing the item did not empty the chip",
    });
    await pressEscape(taskId);
    await browser.waitUntil(async () => (await onDisk(taskId, tab)).length === 0, {
      timeout: 5_000, timeoutMsg: "the removed item is still in the task file",
    });
  });

  it("an item that came due while the task was closed is sent once on reopen", async () => {
    const tab = await mainTab(taskId);
    // Written straight to the file with a date in the past, the state a real
    // week-long wait leaves behind.
    await browser.execute(async (t, tb, at) => {
      const s = window.__termic!.useApp.getState();
      s.stopTask(t);
      s.setActiveTask(null);
      await window.__termic!.ipc.taskSetTabScheduled(t, tb, [
        { id: crypto.randomUUID(), text: "overdue check", not_before: at, created: at },
      ]);
    }, taskId, tab, Date.now() - 3 * DAY);
    expect(await onDisk(taskId, tab)).toEqual(["overdue check"]);

    const reopenedAt = Date.now();
    await reopenFromDisk(taskId);
    // Delivered: the queue empties, the file forgets it, and a submit stamped
    // the tab (terminal output is a canvas, so the stamp is the evidence).
    await browser.waitUntil(async () => (await onDisk(taskId, tab)).length === 0, {
      timeout: 30_000, interval: 300, timeoutMsg: "the overdue message was never delivered",
    });
    const t = await browser.execute(
      (id, tb) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((x: any) => x.id === tb),
      taskId, tab,
    ) as any;
    expect(t.queue ?? []).toEqual([]);
    expect(t.lastInputAt).toBeGreaterThan(reopenedAt);
    await waitForText("Scheduled message sent (due 3 days ago)");
  });

  it("closing a secondary tab that holds one asks before deleting it", async () => {
    const tb = await browser.execute((t) => {
      const tab = { id: crypto.randomUUID(), type: "terminal", cli: "fakeagent", title: "Second" };
      window.__termic!.useApp.getState().addTab(t, tab as never);
      return tab.id;
    }, taskId);
    await browser.waitUntil(
      () => browser.execute((t, x) =>
        !!(window.__termic!.useApp.getState().tabs[t] ?? []).find((y: any) => y.id === x)?.ptyId, taskId, tb),
      { timeout: 20_000, timeoutMsg: "the secondary agent never spawned" },
    );
    await browser.execute((t, x, at) =>
      window.__termic!.useApp.getState().scheduleAgentMessage(t, x, "later", at), taskId, tb, Date.now() + DAY);
    await browser.waitUntil(async () => (await onDisk(taskId, tb)).length === 1, {
      timeout: 5_000, timeoutMsg: "the secondary tab's schedule was not saved",
    });

    await browser.execute((x) =>
      (document.querySelector(`[data-tab-id="${x}"] button[title="Close tab"]`) as HTMLElement).click(), tb);
    await waitForText("Delete scheduled messages?");
    await snap("scheduled-message-close.png");
    // Backing out keeps the tab and its schedule.
    await browser.keys("Escape");
    await waitForTextGone("Delete scheduled messages?");
    expect(await browser.execute((t, x) =>
      (window.__termic!.useApp.getState().tabs[t] ?? []).some((y: any) => y.id === x), taskId, tb)).toBe(true);
    expect(await onDisk(taskId, tb)).toEqual(["later"]);
  });
});

// P2: per-task agent extras. Cases: toggling YOLO mode; opening an aux (bottom)
// terminal for a task.
describe("agent extras", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const task = () =>
    browser.execute(
      (id) =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id),
      taskId,
    );

  it("toggles YOLO mode on a task", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-extras");
    const before = !!(await task())?.yolo;
    await browser.execute(
      (id, b) => window.__termic!.useApp.getState().setTaskYolo(id, !b),
      taskId,
      before,
    );
    await browser.waitUntil(async () => !!(await task())?.yolo !== before, {
      timeout: 8_000,
      timeoutMsg: "YOLO never toggled",
    });
    // restore
    await browser.execute(
      (id, b) => window.__termic!.useApp.getState().setTaskYolo(id, b),
      taskId,
      before,
    );

    // Each toggle asks the live agent's pane whether to restart, and the window
    // has ONE confirm slot, so leaving it up blocks every later dialog in this
    // file (it used to sit over the whole suite). Answer it: "Later".
    //
    // Waited for, not required: toggling and restoring back-to-back can land in
    // a single React commit, and then `effYolo` never changes as far as the
    // pane is concerned, so nothing is asked. The invariant worth asserting is
    // that nothing is left standing, not that something appeared.
    await browser
      .waitUntil(() => browser.execute(() => !!window.__termic!.useUI.getState().confirm),
        { timeout: 5_000, interval: 200 })
      .catch(() => {});
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      if (ui.confirm) ui.resolveConfirm(false);
    });
    expect(await browser.execute(() => !!window.__termic!.useUI.getState().confirm)).toBe(false);
  });

  // Driven through the REAL footer button, not through `addBottomTab`. The
  // button used to call `toggleTerminalSplit` alone, which opens the split and
  // lets TaskView seed an UNFOCUSED shell, so the user had to click the
  // terminal before typing. A store-level drive cannot see that wiring.
  it("opens an aux (bottom) terminal from the footer button and focuses it", async () => {
    await ensureActiveTask(taskId!);
    await clickByText("Terminal");

    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => (window.__termic!.useApp.getState().bottomTabs[id] ?? []).length >= 1,
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "aux terminal was not added" },
    );

    // AuxTerminal focuses itself only once its PTY is live and the grid has
    // rendered, so this is a wait, not an immediate read.
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !!document.activeElement?.closest("[data-bottom-split]"),
        ),
      { timeout: 20_000, interval: 250, timeoutMsg: "aux terminal never took focus" },
    );

    await snap("agent-extras.png");
  });

  // The chevron drives `toggleTerminalSplitCollapsed` directly, so the focus
  // move has to live in that action. Collapsing hides the shell with
  // display:none, which drops focus to <body> and swallows every keystroke.
  it("hands focus back on collapse and takes it again on expand", async () => {
    await clickWhenVisible(
      `[data-task-id="${taskId}"] button[title="Collapse terminal"]`,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !document.activeElement?.closest("[data-bottom-split]"),
        ),
      { timeout: 10_000, interval: 250, timeoutMsg: "focus stayed in the collapsed split" },
    );

    await clickWhenVisible(
      `[data-task-id="${taskId}"] button[title="Expand terminal"]`,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !!document.activeElement?.closest("[data-bottom-split]"),
        ),
      { timeout: 10_000, interval: 250, timeoutMsg: "expanding did not focus the shell" },
    );
  });

  // Clicking a pill only set the active tab; AuxTerminal never self-focuses on
  // becoming active, so focus stayed in the shell the user just left.
  it("focuses the shell whose pill is clicked", async () => {
    const first: string = await browser.execute(
      (id) => window.__termic!.useApp.getState().bottomTabs[id][0].id as string,
      taskId,
    );
    // A second shell, so the click is a real switch. addBottomTab focuses it.
    await browser.execute(
      (id) => window.__termic!.useApp.getState().addBottomTab(id),
      taskId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (id, f) => window.__termic!.useApp.getState().activeBottomTab[id] !== f,
          taskId,
          first,
        ),
      { timeout: 8_000, timeoutMsg: "the second shell never became active" },
    );

    await clickWhenVisible(
      `[data-bottom-split] [data-scroll-strip] [data-tab-id="${first}"]`,
    );
    await browser.waitUntil(
      () =>
        // The pill carries the same data-tab-id as the terminal host, so the
        // assertion pins the xterm textarea specifically, not just the id.
        browser.execute(
          (f) =>
            !!document.activeElement?.classList.contains("xterm-helper-textarea") &&
            document.activeElement.closest("[data-tab-id]")?.getAttribute("data-tab-id") === f,
          first,
        ),
      { timeout: 10_000, interval: 250, timeoutMsg: "clicking the pill did not focus its shell" },
    );

    // Back to one shell, so the next case closes the last one.
    await browser.execute(
      (id) => {
        const st = window.__termic!.useApp.getState();
        const extra = st.bottomTabs[id].filter((t: any) => t.id !== st.bottomTabs[id][0].id);
        extra.forEach((t: any) => st.closeBottomTab(id, t.id));
      },
      taskId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => window.__termic!.useApp.getState().bottomTabs[id].length === 1,
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "the extra shell never closed" },
    );
  });

  // Closing the last shell closes the split, so the footer button comes back
  // and the next open starts from the same state as the first.
  it("closes the split when the last shell closes", async () => {
    const tabId = await browser.execute(
      (id) => window.__termic!.useApp.getState().bottomTabs[id][0].id,
      taskId,
    );
    await browser.execute(
      (id, tid) => window.__termic!.useApp.getState().closeBottomTab(id, tid),
      taskId,
      tabId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => !window.__termic!.useApp.getState().terminalSplit[id],
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "split stayed open after the last shell closed" },
    );
  });
});

// P1: the agent registry (Settings → Agent CLIs). Guards disabling/enabling an
// agent CLI through agentsSave. Uses "gemini" (not the test agents) and always
// restores it.
describe("agent settings", () => {
  const AGENT = "gemini";

  const setDisabled = (disabled: boolean) =>
    browser.execute(
      async (id, dis) => {
        const st = window.__termic!.useApp.getState();
        const next = st.agents.map((a: any) =>
          a.id === id ? { ...a, disabled: dis } : a,
        );
        await window.__termic!.ipc.agentsSave(next);
        await st.loadAll();
      },
      AGENT,
      disabled,
    );
  const isDisabled = () =>
    browser.execute(
      (id) =>
        !!window.__termic!.useApp
          .getState()
          .agents.find((a: any) => a.id === id)?.disabled,
      AGENT,
    );

  after(async () => {
    await setDisabled(false);
  });

  it("disables an agent CLI", async () => {
    await waitForAppShell();
    await requireTermicApi();
    expect(await isDisabled()).toBe(false);
    await setDisabled(true);
    await browser.waitUntil(async () => (await isDisabled()) === true, {
      timeout: 8_000,
      timeoutMsg: "agent never became disabled",
    });
  });

  it("re-enables an agent CLI", async () => {
    await setDisabled(false);
    await browser.waitUntil(async () => (await isDisabled()) === false, {
      timeout: 8_000,
      timeoutMsg: "agent never re-enabled",
    });
    await snap("agent-settings.png");
  });
});

// P0: an agent that backgrounds work ends its own turn while the work runs, so
// its title goes to the idle glyph and every byte-stream signal reads
// "finished". Measured against real claude: a done badge held for 617s while
// three subagents worked. The only thing that says otherwise is the agent's own
// status line, so the done is held back while that line is on screen.
describe("pending work defers done", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("holds the done badge while the agent reports work outstanding", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    taskId = await openTask("e2e-pending-work");
    await waitForAgentReady(taskId);

    await submitToAgent(taskId, "#pending 2");
    await waitForWorkBadge(taskId, "working", {
      timeout: 10_000,
      message: "agent never showed a working badge",
    });

    // Give every done path a real chance to fire before asserting it did not.
    // Not a fixed sleep: this waits on app state (bytes stopped arriving) past
    // the two thresholds that would otherwise fire — byte-quiet at 4s and the
    // settle timer at 5s. Without clearing those, "still working" would prove
    // nothing.
    await browser.waitUntil(async () => (await quietFor(taskId!)) > 9_000, {
      timeout: 25_000,
      interval: 500,
      timeoutMsg: "PTY never went quiet",
    });

    // Still spinning, and no bell — the hold is a hold, not a swallowed done.
    expect(await taskViewBadge(taskId)).toBe("working");
    await snap("agent-pending-held.png");
  });

  it("fires done once the agent's status line clears", async () => {
    await submitToAgent(taskId!, "#settle");
    await waitForWorkBadgeGone(taskId!, "working", {
      timeout: 25_000,
      interval: 300,
      message: "done never fired after the work landed",
    });
    await snap("agent-pending-settled.png");
  });
});

// P0: the hold above must not be able to pin a tab to "working" forever. A
// status line that never clears (a background shell that outlives the turn, or
// the words still sitting in the tail after the work landed) leaves the screen
// byte-quiet and unchanging, so every demoter either fires into the hold or
// latches itself off. The absolute ceiling is the only thing that outranks the
// hold, and it was unreachable: byte-quiet gave up the tick on a held done, so
// the ceiling below it never ran and the tab stayed "working" until the user
// clicked it. Shortened here via the workDoneCeilingMs debug knob, since the
// real one is ten minutes.
describe("a hold that never clears still ends", () => {
  let taskId!: string;
  const CEILING_MS = 8_000;

  after(async () => {
    await browser.execute(() => localStorage.removeItem("workDoneCeilingMs"));
    if (taskId) await archiveTask(taskId);
  });

  it("force-clears the working state at the absolute ceiling", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    await browser.execute((ms) => localStorage.setItem("workDoneCeilingMs", String(ms)), CEILING_MS);
    taskId = await openTask("e2e-pending-ceiling");
    await waitForAgentReady(taskId);

    // Same drill as the hold spec, and #settle is never sent: the pending line
    // stays on screen for the rest of the test.
    await submitToAgent(taskId, "#pending 2");
    await waitForWorkBadge(taskId, "working", {
      timeout: 10_000,
      message: "agent never showed a working badge",
    });

    await waitForWorkBadgeGone(taskId, "working", {
      timeout: CEILING_MS + 20_000,
      interval: 500,
      message: "the held done never reached the ceiling — tab pinned to working",
    });
    await snap("agent-pending-ceiling.png");
  });
});

// P0: the same backstop, for a tab whose agent reports its own state. This is
// the case that was actually UNBOUNDED, and it needs its own task because the
// ceiling override is resolved once when the sampler starts: setting it on a
// tab that is already mounted changes nothing.
//
// The reported case was a claude session that published an artifact. That opens
// an ambient websocket monitor which stays `running` for the rest of the
// session, claude reports it in every later `Stop` payload, and the done hook's
// old "is background_tasks non-empty" guard dropped every one of them. The
// guard is a whitelist now, so that particular hole is shut. The reason it was
// unbounded is here, not in the hook: the absolute ceiling sat BELOW the
// hooks-own gate and never ran, so a hook done that never arrives had nothing
// behind it at all, across new turns and finished turns.
//
// `#hookturn` is that shape exactly: 133;C, then a title going idle, and no
// 133;D ever. The suppression spec above asserts such a tab is still working at
// 8s, which is right. This asserts it does not stay that way forever.
describe("a hook-owned turn whose done never arrives still ends", () => {
  let taskId!: string;
  const CEILING_MS = 8_000;

  after(async () => {
    await browser.execute(() => localStorage.removeItem("workDoneCeilingMs"));
    await setHooksOwnState("fakeagent", false);
    if (taskId) await archiveTask(taskId);
  });

  it("force-clears the working state at the absolute ceiling", async function () {
    this.timeout(90_000);
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    await setHooksOwnState("fakeagent", true);
    await browser.execute((ms) => localStorage.setItem("workDoneCeilingMs", String(ms)), CEILING_MS);
    taskId = await openTask("e2e-hook-ceiling");
    await waitForAgentReady(taskId);

    await submitToAgent(taskId, "#hookturn");
    await waitForWorkBadge(taskId, "working", {
      timeout: 20_000,
      message: "the hook-owned turn never reached the working badge",
    });

    // The hook said 133;C and will never say 133;D, the title has gone idle and
    // is ignored, and every heuristic demoter is stood down for this tab. The
    // ceiling is the only thing left.
    await waitForWorkBadgeGone(taskId, "working", {
      timeout: CEILING_MS + 30_000,
      interval: 500,
      message: "a hook done never came and the ceiling never fired - tab pinned to working",
    });

    // And it clears the spinner WITHOUT claiming the turn finished. The
    // ceiling fires because termic does not know what the agent is doing, so a
    // "done" badge (and the notification that rides with it) states as fact
    // something it only guessed. `idle` is the honest end state: nothing is
    // spinning, nothing is claimed. Reported from a real turn, where the badge
    // corrected itself on the next heartbeat and the notification could not.
    const after = await workBadges(taskId);
    if (after.includes("done")) {
      throw new Error(`the ceiling announced done rather than going idle (badges: ${after.join()})`);
    }
    await snap("agent-hook-ceiling.png");
  });

  // The ceiling must be a BACKSTOP, not a latch.
  //
  // It calls `fireDone` directly rather than going through `goIdle`, and
  // `fireDone` resets neither `localBusy` nor the clock. So the first firing
  // used to leave the clock parked on a turn start from a full ceiling ago:
  // the next heartbeat re-armed working, `goBusy`'s busy-EDGE check skipped
  // the reset, and the ceiling fired again on the same stale timestamp about a
  // second later. For the rest of the turn.
  //
  // Found in the wild on a claude orchestrator running staged subagents, from
  // termic-workstate.log: working :18.177, done :19.303, working :42.859, done
  // :43.339, the same `turn` id throughout. The tab read done while a
  // subagent was visibly working, which is the exact failure the ceiling is
  // there to prevent.
  //
  // Asserts on DURATION rather than on a state, because the latched version
  // reached "working" too. What it could not do is stay there.
  it("re-arms after the ceiling instead of latching done", async function () {
    this.timeout(120_000);
    await waitForWorkBadgeGone(taskId, "working", {
      timeout: CEILING_MS + 30_000,
      message: "the first ceiling never fired, so there is nothing to re-arm from",
    });

    // A second hook turn, after the ceiling has already spent itself once.
    await submitToAgent(taskId, "#hookturn");
    await waitForWorkBadge(taskId, "working", {
      timeout: 30_000,
      message: "the re-armed hook turn never reached working at all",
    });

    // Survive comfortably longer than the ~1s the latch allowed, and stop well
    // short of the ceiling so a correct fire cannot be mistaken for the bug.
    const held = Math.floor(CEILING_MS / 2);
    await browser.pause(held);
    // Both surfaces, because the latch showed up on the sidebar row first.
    const badges = await workBadges(taskId);
    if (!badges.includes("working")) {
      throw new Error(
        `working lasted under ${held}ms after the ceiling (badges: ${badges.join()}), so it latched`,
      );
    }
  });
});

// P0: a done we got wrong must not outlive the evidence. Every heuristic here
// can misread a stage boundary in a long multi-stage turn as the end of it, and
// the recovery used to be a click: agent signals could never undo a "done", so
// the tab showed no spinner for the rest of the turn, and the turn's one done
// token was already spent so the real completion badged nothing.
describe("a premature done is taken back", () => {
  let a: string | undefined;
  let b: string | undefined;
  after(async () => {
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  // The ONLY case in this file that needs more than mocha's 60s default, and
  // it is raised on purpose rather than left to be killed by it. The fixture
  // burns ~19s that cannot be compressed away: a 16s idle window (it must
  // outlast STICKY_DONE_MS = 8s counted from when the done FIRES, ~6s in, or
  // stage 2's busy signal is ignored as post-answer glyph flicker), plus
  // stage 2 and the settle. Six sequential waits sit on top. Left at 60s, the
  // last waits are unreachable: a stall gets killed mid-wait with mocha's
  // generic "timeout of 60000ms exceeded" and no clue which signal never
  // arrived. Raised, each wait reaches its own bound — so a stall FAILS FASTER
  // (at the wait that broke) and names what it was waiting for.
  it("returns to working, then still fires the real done", async function () {
    this.timeout(95_000);
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();

    a = await openTask("e2e-stage-a");
    await waitForAgentReady(a);

    // Task B exists BEFORE the submit. A's done only badges while nobody is
    // watching it (a focused tab's done is downgraded to idle on the spot), so
    // A has to be backgrounded before stage 1 ends — and creating a task takes
    // ~1.5s, which used to race the fixture's stage-1 spinner. The fixture
    // padded that spinner to 6s to cover the race. Creating B up front makes
    // backgrounding a sub-millisecond store call instead, so there is nothing
    // left to race and the fixture's padding could go (see `#stage` in
    // scripts/fake-agent.sh).
    b = await openTask("e2e-stage-b");
    await ensureActiveTask(a);

    await submitToAgent(a, "#stage");
    await waitForWorkBadge(a, "working", {
      timeout: 10_000,
      message: "agent never showed a working badge",
    });

    // Background A. From here on the sidebar row is the surface under test.
    await ensureActiveTask(b);

    await browser.waitUntil(async () => (await sidebarBadge(a!)) === "done", {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: "the premature done never showed in the sidebar",
    });

    // Stage 2 starts. The spinner has to come back on its own, and the wrong
    // bullet has to go with it — a spinner is what the sidebar shows only once
    // the done AND its bell are gone (attention outranks both).
    await browser.waitUntil(async () => (await sidebarBadge(a!)) === "working", {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: "the sidebar row never went back to a working badge",
    });

    // And the turn's real ending still has a done to spend.
    await browser.waitUntil(
      async () => {
        const badge = await sidebarBadge(a!);
        return badge === "done" || badge === "attention";
      },
      { timeout: 15_000, interval: 300, timeoutMsg: "the real completion badged nothing" },
    );
    await snap("agent-stage-recovered.png");
  });
});

// P0 (GH #276): one turn is allowed to interrupt the user ONCE.
//
// The two cases below are the same bug reached down two different code paths,
// and neither existed until a user reported "notifications for what seems like
// every action". The mechanism is a loop between three places that are each
// individually right:
//
//   1. a done fires  -> markAttention("done") -> the tab's `unread` goes from
//      null to set, and that RISING EDGE is exactly what useAttentionNotifier
//      turns into an OS banner.
//   2. the agent goes back to work -> setWorkState("working") in store/app.ts
//      CLEARS that unread, deliberately: leaving "this finished" on a visibly
//      working tab would be a lie.
//   3. the turn ends again -> another rising edge -> another banner.
//
// So every premature done in a long turn costs one notification, and a long
// agentic turn has many. The notifier's own 8s debounce is no defence at all
// against a turn measured in minutes.
//
// Counted on the rising edge rather than on `notify()` itself on purpose: the
// notifier imports `notify` as a live ESM binding, so there is nothing a spec
// can hook, and the edge is what it consumes one-for-one anyway (its only
// other gates are the focus check, which `setWindowPresence(false)` settles,
// and the debounce this is about).
describe("one turn raises one notification", () => {
  const ids: string[] = [];
  after(async () => {
    for (const id of ids) await archiveTask(id);
  });

  /** Count what the notifier consumes, and separately what the sidebar shows.
   *
   *  The OS banner itself is NOT the observable here, and that was measured
   *  rather than assumed: `ipc.notify` bails at `ensureNotifyPermission()`
   *  before it ever reaches the plugin, so an e2e binary asks the OS for
   *  nothing and a count of notification commands reads 0 both before and after
   *  the fix. The `__TAURI_INTERNALS__.invoke` wrapper below is kept anyway,
   *  because it is the only hook a page HAS (`notify` is a live ESM binding)
   *  and a run with permission granted gets the count for free. It is reported,
   *  never asserted.
   *
   *  So the assertion is on the newsworthy rising edge: the last decision
   *  before `notify()`, mapping to banners one-for-one. */
  const armCounters = (taskId: string) =>
    browser.execute((id) => {
      const w = window as unknown as {
        __notifyCount?: number;
        __notifyCmds?: string[];
        __unreadEdges?: number;
        __newsEdges?: number;
        __unreadStop?: () => void;
        __invokeRestore?: () => void;
        __TAURI_INTERNALS__?: { invoke: (...a: unknown[]) => unknown };
      };
      w.__unreadStop?.();
      w.__invokeRestore?.();
      w.__notifyCount = 0;
      w.__notifyCmds = [];
      w.__unreadEdges = 0;
      w.__newsEdges = 0;

      const internals = w.__TAURI_INTERNALS__;
      if (internals) {
        const original = internals.invoke;
        internals.invoke = (...args: unknown[]) => {
          const cmd = String(args[0] ?? "");
          if (/notif/i.test(cmd)) {
            w.__notifyCount = (w.__notifyCount ?? 0) + 1;
            w.__notifyCmds!.push(cmd);
          }
          return original.apply(internals, args as never);
        };
        w.__invokeRestore = () => { internals.invoke = original; };
      }

      // Two counts, because the fix has to move one and not the other:
      //   edges  - every null -> set transition. This is the sidebar dot, and
      //            a long turn is SUPPOSED to produce several.
      //   news   - the same transitions measured on newsworthiness rather than
      //            truthiness, which is exactly what useAttentionNotifier
      //            turns into a banner (lib/attentionNotify.ts).
      // Both maps start empty, so a first mark is itself an edge.
      const seen = new Map<string, boolean>();
      const seenNews = new Map<string, boolean>();
      w.__unreadStop = window.__termic!.useApp.subscribe((s: { tabs: Record<string, Array<{ id: string; unread?: { repeat?: boolean } | null }>> }) => {
        for (const tab of s.tabs[id] ?? []) {
          const now = !!tab.unread;
          if (now && !(seen.get(tab.id) ?? false)) w.__unreadEdges = (w.__unreadEdges ?? 0) + 1;
          seen.set(tab.id, now);
          const news = !!tab.unread && tab.unread.repeat !== true;
          if (news && !(seenNews.get(tab.id) ?? false)) w.__newsEdges = (w.__newsEdges ?? 0) + 1;
          seenNews.set(tab.id, news);
        }
      });
    }, taskId);

  const readCounters = () =>
    browser.execute(() => {
      const w = window as unknown as {
        __notifyCount?: number; __notifyCmds?: string[];
        __unreadEdges?: number; __newsEdges?: number;
      };
      return {
        banners: w.__notifyCount ?? 0,
        cmds: w.__notifyCmds ?? [],
        edges: w.__unreadEdges ?? 0,
        news: w.__newsEdges ?? 0,
      };
    }) as Promise<{ banners: number; cmds: string[]; edges: number; news: number }>;

  const disarm = () =>
    browser.execute(() => {
      const w = window as unknown as {
        __unreadStop?: () => void; __invokeRestore?: () => void;
      };
      w.__unreadStop?.();
      w.__invokeRestore?.();
      w.__unreadStop = undefined;
      w.__invokeRestore = undefined;
    });

  /** Both drills are a two-stage turn: work, look finished, work, finish. */
  const runTwoStageTurn = async (name: string, directive: string) => {
    const taskId = await openTask(name);
    ids.push(taskId);
    await waitForAgentReady(taskId);
    // Away: a done on a watched tab is downgraded to idle on the spot and
    // never badges, so the bug is only reachable with nobody looking. That is
    // also the reporter's repro ("run a task and unfocus the application").
    await setWindowPresence(false);
    await armCounters(taskId);
    await submitToAgent(taskId, directive);

    // Stage 1's premature done, then stage 2 taking it back, then the real
    // ending. Waiting through all three is what proves the counter saw the
    // whole turn rather than stopping at the first badge.
    await browser.waitUntil(async () => (await sidebarBadge(taskId)) === "done", {
      timeout: 25_000, interval: 300,
      timeoutMsg: "the premature done never badged; the drill did not run",
    });
    await browser.waitUntil(async () => (await sidebarBadge(taskId)) === "working", {
      timeout: 25_000, interval: 300,
      timeoutMsg: "the agent never went back to work; the drill did not run",
    });
    await browser.waitUntil(async () => {
      const b = await sidebarBadge(taskId);
      return b === "done" || b === "attention";
    }, {
      timeout: 25_000, interval: 300,
      timeoutMsg: "the real completion badged nothing",
    });
    const counters = await readCounters();
    await disarm();
    await setWindowPresence(true);
    return counters;
  };

  // The heuristic path: no hooks, the title and the settle timers own the
  // turn. This is codex's ONLY path (it is not in agent_hooks SUPPORTED), and
  // claude's whenever its hooks are off.
  it("does not re-notify when a heuristic done is taken back and re-fired", async function () {
    this.timeout(120_000);
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    const { edges, news } = await runTwoStageTurn("e2e-notify-once-title", "#stage");
    // 2 before the fix: one banner per stage boundary.
    expect(news).toBe(1);
    // ...while the dot still tracks BOTH boundaries. A fix that suppressed the
    // edge would have taken the sidebar marker with it, which is why this is
    // asserted rather than left to whatever the fix happened to do.
    expect(edges).toBe(2);
    await snap("agent-notify-once-title.png");
  });

  // The hook path, which needed its own case because it does not share a
  // single guard with the one above: a 133;D calls fireDone with `fromHook`,
  // which skips the one-done-per-submit token entirely. A captured
  // termic-workstate.log from real claude use shows `CDCDCDCDCD` on ordinary
  // tasks, so this is the common shape, not an exotic one.
  it("does not re-notify when a HOOK reports two dones in one turn", async function () {
    this.timeout(120_000);
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    const { edges, news } = await runTwoStageTurn("e2e-notify-once-hook", "#hookstage");
    expect(news).toBe(1);
    expect(edges).toBe(2);
    await snap("agent-notify-once-hook.png");
  });
});

// P0: an agent asking for the user must raise ATTENTION, not "done". Claude
// sends this ~6s after its title goes idle, i.e. always just behind our own
// done paths, so attention has to be able to land on top of a done we already
// fired. It also sends a second, non-actionable notification a minute after any
// turn you don't reply to; badging that would ring a bell for finished work.
describe("agent notifications", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("raises attention with the agent's own wording", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    taskId = await openTask("e2e-agent-notify");
    await waitForAgentReady(taskId);
    // Away, which is the only state in which a badge is meant to persist.
    await setWindowPresence(false);

    await submitToAgent(taskId, "#osc9 FakeAgent needs your permission");

    // The bell is the visible half.
    await waitForWorkBadge(taskId, "attention", {
      timeout: 15_000,
      message: "OSC 9 never raised an attention badge",
    });
    // The agent's own wording is carried on the notification, which has no DOM
    // surface of its own (it goes to the OS notifier), so read it from state.
    const message = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].unread?.message ?? null,
      taskId,
    );
    expect(message).toBe("FakeAgent needs your permission");
    await snap("agent-notify-attention.png");
  });

  it("ignores the idle nag that claude sends after every unanswered turn", async () => {
    // Clear the previous badge the way focus/typing does, so a stale one can't
    // make this pass.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.clearAttention(id, s.tabs[id][0].id);
    }, taskId);
    expect(await taskViewBadge(taskId!)).not.toBe("attention");

    await submitToAgent(taskId!, "#osc9 FakeAgent is waiting for your input");

    // Prove the directive was consumed (the PTY echoed past it) rather than
    // asserting on a race: bytes must have flowed after the send.
    await browser.waitUntil(async () => (await quietFor(taskId!)) > 6_000, {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: "PTY never went quiet after the nag",
    });

    expect(await taskViewBadge(taskId!)).not.toBe("attention");
    expect(await sidebarBadge(taskId!)).not.toBe("attention");
  });
  // The agent-hooks feature (#269), end to end through the real detector.
  //
  // Measured against Claude Code 2.1.250: while it is blocked on a permission
  // prompt it paints its IDLE glyph, which arms termic's 5s settle and fires a
  // "done" a second before the native OSC 9 notify corrects it. The installed
  // hook returns a terminalSequence that claude writes to its own PTY, and it
  // lands ~20ms after the idle title. `#hookattn` replays that exact order.
  //
  // The assertion that matters is the ABSENCE of a done: goAttention calls
  // cancelSettle, so the false one must never reach the badge at all. Waiting
  // past SETTLE_MS (5s) is what makes that a real check rather than a race the
  // spec happens to win.
  it("an agent hook's OSC 777 raises attention and suppresses the false done", async () => {
    await ensureActiveTask(taskId!);
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.clearAttention(id, s.tabs[id][0].id);
    }, taskId);

    // This spec waits past SETTLE_MS with the badge up, so it MUST say the
    // user is away: three seconds of dwelling in a focused window is now a
    // read receipt, and without this the assertion below would pass or fail on
    // whether the suite's window happened to have focus.
    await setWindowPresence(false);
    await submitToAgent(taskId!, "#hookattn");

    await waitForWorkBadge(taskId!, "attention", {
      timeout: 20_000,
      message: "the hook's OSC 777 never raised attention",
    });

    // Past the settle window the idle title armed. If cancelSettle regressed,
    // a done bullet stacks on top of the bell right about here.
    await browser.waitUntil(async () => (await quietFor(taskId!)) > 7_000, {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: "PTY never went quiet after the hook",
    });
    expect(await taskViewBadge(taskId!)).toBe("attention");
    expect(await sidebarBadge(taskId!)).not.toBe("done");
  });

  // The usage footer (GH #277), end to end through the real OSC chain.
  //
  // ONE submit, and deliberately so. The threshold table, the driving-window
  // rule and the parse are covered exhaustively in `lib/agentUsage.test.ts`,
  // which runs in milliseconds; what only a real window can prove is the
  // CHAIN, and that costs an agent round trip per assertion. An earlier
  // version of this walked four thresholds through four submits and blew
  // mocha's 60s budget, which is a slow suite buying nothing the unit test had
  // not already said.
  //
  // The body is chosen to prove two things at once: the chip renders both
  // numbers, and each one carries its OWN gauge and colour. 30% of five hours
  // in front of 95% of the week has to read as a calm bar beside a red one.
  //
  // There used to be a single bar here, showing whichever window was closest
  // to its limit. It sat against the 5h number and displayed the other one,
  // so it read as that number's gauge and was wrong most of the time.
  // `data-usage-level` still reports the DRIVING window, because that is what
  // `autoSwitch` acts on; it is no longer what the chip draws.
  it("shows plan usage in the footer, one gauge per window", async () => {
    await ensureActiveTask(taskId!);
    await submitToAgent(taskId!, "#usage usage 30 95 - -");

    const chip = await browser.$('[data-testid="usage-chip"]');
    await chip.waitForExist({ timeout: 20_000 });
    // The numbers the USER reads, not the store field behind them.
    expect(await chip.getAttribute("data-usage-session")).toBe("30");
    expect(await chip.getAttribute("data-usage-weekly")).toBe("95");
    expect(await chip.getAttribute("data-usage-source")).toBe("statusline");
    expect(await chip.getAttribute("data-usage-level")).toBe("critical");
    expect(await chip.getText()).toContain("30%");
    expect(await chip.getText()).toContain("95%");
    // One gauge per window, and each one is the BACKGROUND of its own number,
    // so the 5h figure can never be sitting next to the week's bar. Assert the
    // value each gauge was drawn to rather than counting elements: a gauge
    // pointed at the wrong window is the bug this readout exists to prevent,
    // and two elements of any kind would satisfy a count.
    expect(await (await browser.$$('[data-testid="usage-gauge"]')).length).toBe(2);
    const fiveH = await browser.$('[data-usage-window="5h"]');
    const week = await browser.$('[data-usage-window="wk"]');
    expect(await fiveH.getText()).toContain("30%");
    expect(await week.getText()).toContain("95%");
    expect(await fiveH.getAttribute("data-usage-fill")).toBe("30");
    expect(await week.getAttribute("data-usage-fill")).toBe("95");
    // The fill is a gradient with a hard stop at the percentage, so the stop
    // is the thing that has to be there: a background that lost its gradient
    // (a dropped inline style, a theme token that resolved to nothing) still
    // renders a perfectly plausible chip.
    expect((await week.getCSSProperty("background-image")).value).toContain("gradient");
  });

  // Its own `it`, and the reason is the budget the case above is written
  // against: that one spends most of 60s on a real agent round trip, and two
  // screenshots on top of it tipped it into mocha's timeout. Tests in a file
  // share the window and run in order, so the 30/95 state is still on screen
  // here and this costs one render plus two captures.
  //
  // Screenshots only. Nothing is asserted from a pixel (see the e2e skill);
  // these exist so a person can check that a gauge which is a BACKGROUND still
  // renders as one, which is the class of thing no assertion catches and which
  // this footer has already been burned by once (`transition-colors` never
  // repaints a themed colour in WKWebView, docs/gotchas.md).
  it("draws a gauge at each level for a human to look at", async () => {
    await ensureActiveTask(taskId!);
    await snap("usage-gauge-critical.png");

    // The WARN ink, which is the step this design added: the figure goes
    // neutral-bright on a hued fill instead of taking the hue itself, because
    // amber on amber measures 3.3:1 in dark mode.
    //
    // Rewrites the reading the chip is ALREADY showing rather than reporting a
    // new one: `report` files under `usageKey(agentId, account)` and the
    // account is the one the PROCESS spawned with, so a spec that passes
    // `null` quietly creates a second entry the chip never reads.
    await browser.execute(() => {
      const store = window.__termic!.useAgentUsage;
      const byAgent = { ...store.getState().byAgent };
      const key = Object.keys(byAgent)[0];
      byAgent[key] = {
        ...byAgent[key],
        session: { usedPercent: 75, resetsAt: null },
        weekly: { usedPercent: 20, resetsAt: null },
      };
      store.setState({ byAgent });
    });
    await browser.waitUntil(
      async () => (await (await browser.$('[data-usage-window="5h"]')).getAttribute("data-usage-fill")) === "75",
      { timeout: 10_000, timeoutMsg: "the 5h gauge never redrew at 75%" },
    );
    await snap("usage-gauge-warn.png");
  });

  // The half that is easy to get wrong and expensive to ship wrong. A trusted
  // body skips every notification filter by design, so a usage report routed
  // one branch too late falls through to notifyAttention and badges the tab.
  // This body arrives on every turn of every task, so that bug would mean a
  // bell per turn, forever.
  //
  // The quiet wait is what makes it a real check rather than a race the spec
  // happens to win, and it is the reason this is a second `it` rather than
  // another assertion on the first: the cost buys something no unit test can.
  it("never badges the tab for a usage report", async () => {
    await ensureActiveTask(taskId!);
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.clearAttention(id, s.tabs[id][0].id);
    }, taskId);
    await setWindowPresence(false);

    await submitToAgent(taskId!, "#usage usage 61 44 - -");
    await browser.waitUntil(async () => {
      const el = await browser.$('[data-testid="usage-chip"]');
      return (await el.isExisting()) && (await el.getAttribute("data-usage-session")) === "61";
    }, { timeout: 20_000, timeoutMsg: "the second usage report never landed" });

    await browser.waitUntil(async () => (await quietFor(taskId!)) > 6_000, {
      timeout: 30_000, interval: 500,
      timeoutMsg: "PTY never went quiet after the usage report",
    });
    expect(await taskViewBadge(taskId!)).not.toBe("attention");
    expect(await sidebarBadge(taskId!)).not.toBe("attention");
  });

  // One task, two agents (GH #277). The footer's chip used to be hard-bound to
  // `task.cli`, the agent the task was CREATED with, so a claude tab sitting
  // beside a codex tab got one chip for the task's own agent and nothing at
  // all for the other one - reported on #277 by a user running exactly that
  // pair. The second agent's tab is seeded rather than spawned: a real one
  // needs a second agent CLI installed, and the fixture profile has exactly
  // one.
  it("gives every agent in the task its own footer chip, and keeps the one you are on when the bar is narrow (#277)", async () => {
    await ensureActiveTask(taskId!);
    const SECOND = "fakeagent-2";
    /** Every chip in the ON-SCREEN task's footer, and whether it actually
     *  PAINTS: the narrow-bar rule is a container query, so a dropped chip is
     *  still in the DOM. Scoped to the footer that paints, because every task
     *  the user has visited stays mounted (display:none) with a footer of its
     *  own. */
    const chips = () => browser.execute(() => {
      const footer = [...document.querySelectorAll('[data-testid="task-footer"]')]
        .find(el => el.getClientRects().length > 0);
      return [...(footer?.querySelectorAll('[data-testid="usage-chip"]') ?? [])].map(el => ({
        agent: el.getAttribute("data-usage-agent") ?? "",
        session: el.getAttribute("data-usage-session") ?? "",
        visible: el.getClientRects().length > 0,
      }));
    });
    const shown = async () => (await chips()).filter(c => c.visible).map(c => c.agent);
    const seedUsage = (agent: string, session: number, weekly: number) =>
      browser.execute((a, se, wk) => {
        window.__termic!.useAgentUsage.getState().report(
          a, null,
          {
            session: { usedPercent: se, resetsAt: null },
            weekly: { usedPercent: wk, resetsAt: null },
            sessionCostUsd: null,
          },
          "statusline");
      }, agent, session, weekly);
    try {
      await browser.execute((id, second) => {
        window.__termic!.useApp.setState((s: any) => ({
          tabs: {
            ...s.tabs,
            [id!]: [...s.tabs[id!], {
              id: "e2e-second-agent-tab", type: "terminal", cli: second,
              title: second, is_default: false,
            }],
          },
        }));
      }, taskId, SECOND);
      await seedUsage("fakeagent", 12, 34);
      await seedUsage(SECOND, 56, 78);

      // Both agents, task's own first, each carrying its OWN numbers. The bug
      // was one chip speaking for the whole task.
      await browser.waitUntil(
        async () => (await shown()).length === 2,
        { timeout: 8_000, timeoutMsg: "the second agent in the task never got a chip" });
      const both = await chips();
      expect(both.map(c => c.agent)).toEqual(["fakeagent", SECOND]);
      expect(both.map(c => c.session)).toEqual(["12", "56"]);
      await snap("footer-two-agents.png");

      // Now take the room away. The footer IS the container the rule is
      // written against (`@container` sits on it), so its width is set
      // directly rather than by dragging a column: neither the sidebar nor the
      // right panel can squeeze this window's task pane below the threshold -
      // the sidebar caps at 33vw and the right panel at 35vw - so a drag would
      // assert nothing here. The rule itself is evaluated by the real engine
      // either way. The chip that survives is the one whose tab is on screen,
      // which is the task's own agent.
      const setFooterWidth = (px: string) => browser.execute((w) => {
        const el = [...document.querySelectorAll('[data-testid="task-footer"]')]
          .find(e => e.getClientRects().length > 0) as HTMLElement | undefined;
        if (el) el.style.width = w;
      }, px);
      await setFooterWidth("600px");
      await browser.waitUntil(
        async () => (await shown()).length === 1,
        { timeout: 8_000, timeoutMsg: "a footer with no room for both chips still drew both" });
      expect(await shown()).toEqual(["fakeagent"]);
      await snap("footer-two-agents-narrow.png");
      // Dropped, not unmounted: it is still in the DOM, still reporting, and
      // it comes back with the room.
      expect((await chips()).map(c => c.agent)).toEqual(["fakeagent", SECOND]);

      await setFooterWidth("");
      await browser.waitUntil(
        async () => (await shown()).length === 2,
        { timeout: 8_000, timeoutMsg: "the second chip never came back with the room" });
    } finally {
      await browser.execute((id) => {
        window.__termic!.useApp.setState((s: any) => ({
          tabs: { ...s.tabs, [id!]: (s.tabs[id!] ?? []).filter((t: any) => t.id !== "e2e-second-agent-tab") },
        }));
      }, taskId);
      await browser.execute(() => {
        for (const el of document.querySelectorAll('[data-testid="task-footer"]')) {
          (el as HTMLElement).style.width = "";
        }
      });
    }
  });

  // Looking at a tab is how you read its badge. `markAttention` marks
  // unconditionally, focused tab included, and the badge then cleared only on
  // a keystroke in that terminal or on re-activating the task, so the common
  // case stuck: the tab you are already on earns a badge while you are in
  // another app, you come back, and because the tab never CHANGED nothing
  // cleared it. Clicking away and back was the only way out.
  it("clears a badge on the tab you are looking at, once you are back", async () => {
    await ensureActiveTask(taskId!);
    await setWindowPresence(false);
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.clearAttention(id, s.tabs[id][0].id);
    }, taskId);

    await submitToAgent(taskId!, "#osc9 FakeAgent needs your permission");
    await waitForWorkBadge(taskId!, "attention", {
      timeout: 20_000,
      message: "the badge never appeared while the user was away",
    });

    // Still away, and still badged. Without this the test would also pass on a
    // bug that simply drops every attention, since the assertion below is that
    // a badge went away.
    expect(await taskViewBadge(taskId!)).toBe("attention");

    // Back at the keyboard, on that very tab.
    await setWindowPresence(true);
    await waitForWorkBadgeGone(taskId!, "attention", {
      timeout: 20_000,
      message: "returning to a focused window never cleared the badge on the visible tab",
    });
  });
  // Once an agent reports its own state, the terminal TITLE stops being
  // allowed to end a turn for it. This is the case the whole design turns on:
  // measured over an 8.5 minute run with four real subagents, claude's title
  // claimed idle for 30% of the time while the work was still outstanding,
  // and its own Stop correctly stayed silent throughout. Trusting both means
  // trusting the wrong one.
  describe("when an agent reports its own state", () => {
    const reset = async () => {
      await ensureActiveTask(taskId!);
      await browser.execute((id) => {
        const s = window.__termic!.useApp.getState();
        s.clearAttention(id, s.tabs[id][0].id);
        s.setWorkState(id, s.tabs[id][0].id, "idle");
      }, taskId);
    };
    after(async () => { await setHooksOwnState("fakeagent", false); });

    // NOT covered here: "no hook ever arrives, so the fallbacks must stay
    // armed" (the Docker case, where hooks install into the container and
    // their OSC cannot reach the host pty). It needs a pty that has never
    // seen a hook, and every tab in this file has: `#hookattn` emits an OSC
    // 777 earlier. Two attempts at it disturbed the shared task and broke the
    // case below instead, so it wants its own spec file with its own launch
    // rather than a third try wedged in here. The behaviour itself is
    // `hookSeenRef` in TerminalPane.
    it("ignores the title going idle, so a long turn is not called done early", async () => {
      await setHooksOwnState("fakeagent", true);
      await reset();
      // This tab has already seen a hook (`#hookattn`'s OSC 777, earlier in
      // this file), which is what licenses the suppression under test. The case
      // above covers the opposite: a tab where none ever arrives.

      // An ordinary turn: the fixture spins, then paints claude's idle glyph.
      // That glyph alone used to be enough to end the turn.
      // `#hookturn`: the hook says the turn started and never says it ended,
      // while the title goes idle. That IS the case, and a fixture whose only
      // signal was a title could not produce it now that hooks own both edges.
      await submitToAgent(taskId!, "#hookturn");
      await waitForWorkBadge(taskId!, "working", {
        timeout: 20_000,
        message: "the turn never reached the working badge",
      });

      // Past SETTLE_MS with the PTY quiet, which is precisely the situation
      // that used to fire a done off the title.
      await browser.waitUntil(async () => (await quietFor(taskId!)) > 8_000, {
        timeout: 30_000, interval: 500,
        timeoutMsg: "PTY never went quiet after the turn",
      });
      expect(await taskViewBadge(taskId!)).not.toBe("done");
      expect(await sidebarBadge(taskId!)).not.toBe("done");
    });

    // The interrupt half. claude fires NO hook for one (measured with 29 of
    // its 31 lifecycle events registered), so the keystroke is the only
    // evidence, and it is what licenses the title for that single turn.
    it("stops claiming work when the user interrupts, which no hook reports", async () => {
      await setHooksOwnState("fakeagent", true);
      await reset();

      await submitToAgent(taskId!, "#longwork");
      await waitForWorkBadge(taskId!, "working", {
        timeout: 20_000,
        message: "the long turn never reached the working badge",
      });

      await pressEscape(taskId!);

      // Localise a failure: if the fixture never reacted, the keystroke never
      // reached the PTY and the bug is in the spec, not the detector.
      await browser.waitUntil(
        async () => ((await browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.liveTitle ?? "",
          taskId,
        )) as string).includes("✳"),
        { timeout: 15_000, interval: 250,
          timeoutMsg: "the fixture never went idle, so Escape never reached the PTY" },
      );

      await waitForWorkBadgeGone(taskId!, "working", {
        timeout: 20_000,
        message: "Escape reached the agent, but termic still claims it is working",
      });
      // An interrupt is not a completion: it clears the in-progress state and
      // nothing else, so it must not leave a done badge behind either.
      expect(await taskViewBadge(taskId!)).not.toBe("done");
    });

    // The agy shape, and the reason the keystroke is not enough on its own.
    // Measured mid-turn: agy fires NO hook for an interrupt and publishes no
    // title state either, so the only evidence its user's key landed is the
    // terminal falling quiet. An agent that did NOT act on the key keeps
    // painting (opencode's first Escape does nothing; it takes two), so quiet
    // never arrives and nothing ends: that asymmetry is what makes
    // corroboration safe.
    it("ends an interrupted turn that reports neither a hook nor a title", async () => {
      await setHooksOwnState("fakeagent", true);
      await reset();

      await submitToAgent(taskId!, "#longwork-silent");
      await waitForWorkBadge(taskId!, "working", {
        timeout: 20_000,
        message: "the silent long turn never reached the working badge",
      });

      await pressEscape(taskId!);

      await waitForWorkBadgeGone(taskId!, "working", {
        timeout: 30_000,
        message: "the terminal went quiet after an interrupt, but termic still claims it is working",
      });
      // The fixture holds its busy title through the interrupt, so the other
      // route (title goes idle) could not have fired and the badge can only
      // have cleared on the silence. Doubles as the mis-dispatch check: the
      // fixture's default branch ends on the idle glyph.
      expect(await browser.execute(
        (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.liveTitle ?? "",
        taskId,
      )).not.toContain("✳");
      expect(await taskViewBadge(taskId!)).not.toBe("done");
    });
  });
});

// ── resume in the main checkout, for an agent that reports its own id ──────
//
// The repo root is the one task shape with NO cwd fallback: several tasks
// share a directory, so `--continue` / `resume --last` would lasso somebody
// else's conversation and termic deliberately never sends them there. Resume
// is therefore entirely a function of the stored session id, and if that id
// is missing or never reaches the command line the task comes back empty with
// nothing on screen to say why.
//
// `fakecapture` is codex's shape, measured against a live codex 0.154.0:
// it cannot be TOLD an id at launch (no `--session-id`), it CAN resume one
// (`resume <uuid>`), and its `SessionStart` fires on the FIRST PROMPT rather
// than at spawn, so the id arrives mid-session over termic's hook OSC.
describe("main-checkout resume for a capture-resume agent", () => {
  /** Matches `TERMIC_FAKE_SESSION_ID` on the fixture's registry entry. */
  const SESSION = "11111111-2222-4333-8444-555555555555";
  let taskId: string | null = null;

  /** Argv of every spawn this task has made, oldest first, read from the log
   *  the fixture appends to. The command line is the assertion that matters:
   *  the store can hold a session id while the flag that would have used it
   *  never reaches the process, and that is exactly the bug shape here. */
  function spawnArgv(id: string): string[] {
    const raw = readFileSync(join(dataDir, "e2e-agent-argv.log"), "utf8");
    return raw.split("\n")
      .filter(l => l.startsWith(id + "\t"))
      .map(l => l.slice(id.length + 1));
  }

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("starts fresh, then learns the id the agent reports on the first prompt", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-capture-resume", true, "fakecapture");
    await waitForAgentReady(taskId);

    // Nothing to resume yet, so the first spawn carries no resume block.
    expect(spawnArgv(taskId)).toHaveLength(1);
    expect(spawnArgv(taskId)[0]).not.toContain("resume");

    await submitToAgent(taskId, "hello");
    await browser.waitUntil(
      () => browser.execute(
        (t) => (window.__termic!.useApp.getState().tabs[t] ?? [])[0]?.sessionId ?? null,
        taskId!,
      ).then(v => v === SESSION),
      { timeout: 20_000, timeoutMsg: "the agent reported its session id and termic did not store it" },
    );
  });

  it("resumes that id after the agent tab is closed and the task reopened", async () => {
    const id = taskId!;
    const tabId = await browser.execute(
      (t) => (window.__termic!.useApp.getState().tabs[t] ?? [])[0]?.id as string,
      id,
    );
    // The main agent tab's × — "end it for now", not "forget it": the durable
    // entry survives so the task auto-resumes when it wakes.
    await browser.execute((t, tb) => {
      window.__termic!.useApp.getState().closeTab(t, tb);
    }, id, tabId);
    await browser.waitUntil(
      () => browser.execute(
        (t) => (window.__termic!.useApp.getState().tabs[t] ?? []).length === 0,
        id,
      ),
      { timeout: 10_000, timeoutMsg: "the agent tab never closed" },
    );

    // Reopen the task the way clicking its sidebar row does.
    await browser.execute((t) => {
      const s = window.__termic!.useApp.getState();
      s.setActiveTask(t);
      s.ensureDefaultTab(t, "fakecapture");
    }, id);
    await waitForAgentReady(id);

    await browser.waitUntil(
      () => Promise.resolve(spawnArgv(id).length >= 2),
      { timeout: 20_000, timeoutMsg: "the reopened task never spawned a second agent" },
    );
    const second = spawnArgv(id)[1];
    expect(second).toContain(`resume ${SESSION}`);
  });
});

// ── a claude session that moved: `/clear` and `/resume` (GH #306) ─────────
//
// claude IS told an id at launch (`--session-id`), so it never needed to report
// one. But `/clear` and `/resume` move the conversation to another id inside
// the running process, and a relaunch then resumed the session from before the
// `/clear`: the agent said it had never worked on what the tab was doing.
// claude's READY hook now reports the id on those moves; this replays that
// report over the same OSC and asserts the command line of the next spawn.
describe("a claude session that moves after /clear is the one resumed", () => {
  /** Session ids as the hook reports them after `/clear`: new uuids. */
  const CLEARED = ["22222222-3333-4444-8555-666666666666", "33333333-4444-4555-8666-777777777777", "44444444-5555-4666-8777-888888888888"];
  /** Minted ids are only held once a spawn survives RESUME_FAILURE_MS (2s). */
  const SURVIVE_MS = 2_500;
  let taskId: string | null = null;
  /** Tab ids, captured once at creation. Positions are not stable: tabs are
   *  dragged in the tab bar, so everything below looks tabs up by id. */
  let tabIds: string[] = [];

  function spawnArgv(id: string): string[] {
    const raw = readFileSync(join(dataDir, "e2e-agent-argv.log"), "utf8");
    return raw.split("\n")
      .filter(l => l.startsWith(id + "\t"))
      .map(l => l.slice(id.length + 1));
  }
  const sessions = (id: string) => browser.execute((t, ids) => {
    const st = window.__termic!.useApp.getState();
    const tabs = (st.tabs[t] ?? []) as any[];
    const persisted = (st.tasks.find((w: any) => w.id === t)?.persisted_tabs ?? []) as any[];
    return ids.map(tb => ({
      tab: tabs.find(x => x.id === tb)?.sessionId ?? null,
      persisted: persisted.find(x => x.id === tb)?.session_id ?? null,
      lastInputAt: tabs.find(x => x.id === tb)?.lastInputAt ?? 0,
    }));
  }, id, tabIds);

  /** Type a line into one tab by id: make it the active tab, type into the
   *  visible terminal, and wait on THAT tab's input stamp. */
  async function submitTo(id: string, tabId: string, line: string): Promise<void> {
    await browser.execute((t, tb) => window.__termic!.useApp.getState().setActiveTabId(t, tb), id, tabId);
    await browser.pause(150);
    const idx = tabIds.indexOf(tabId);
    const before = (await sessions(id))[idx].lastInputAt;
    const ok = await browser.execute((t, text) => {
      const host = document.querySelector(`[data-task-id="${t}"]`);
      const ta = [...(host?.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea") ?? [])]
        .find(el => { const r = (el.closest(".xterm") ?? el).getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!ta) return false;
      ta.focus();
      ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
      for (const type of ["keydown", "keyup"]) {
        ta.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true } as KeyboardEventInit));
      }
      return true;
    }, id, line);
    expect(ok).toBe(true);
    await browser.waitUntil(async () => (await sessions(id))[idx].lastInputAt > before,
      { timeout: 10_000, timeoutMsg: `tab ${idx} never took "${line}"` });
  }

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("stores the id each tab reports after /clear, over the id it minted, with three tabs in one task", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-claude-clear", true, "fakeclaude");
    await waitForAgentReady(taskId);
    const id = taskId;
    tabIds = [await browser.execute((t) => (window.__termic!.useApp.getState().tabs[t] ?? [])[0]?.id as string, id)];
    for (let i = 1; i < 3; i++) {
      tabIds.push(await browser.execute((t) => {
        const tab = { id: crypto.randomUUID(), type: "terminal", cli: "fakeclaude", title: "FakeClaude" };
        window.__termic!.useApp.getState().addTab(t, tab as never);
        return tab.id;
      }, id));
    }
    await browser.waitUntil(
      () => browser.execute((t, ids) => ids.every(tb =>
        !!(window.__termic!.useApp.getState().tabs[t] ?? []).find((x: any) => x.id === tb)?.lastOutputAt), id, tabIds),
      { timeout: 30_000, timeoutMsg: "not every agent tab produced output" },
    );
    await browser.pause(SURVIVE_MS);

    // Reorder, as dragging in the tab bar does: nothing below may depend on it.
    await browser.execute((t, tb) => window.__termic!.useApp.getState().reorderTab(t, tb, 0), id, tabIds[2]);

    // A first prompt in each tab persists the id that tab minted.
    for (const tb of tabIds) await submitTo(id, tb, "hello");
    await browser.waitUntil(async () => (await sessions(id)).every(s => !!s.persisted),
      { timeout: 10_000, timeoutMsg: "a tab's minted id was never persisted" });
    const minted = (await sessions(id)).map(s => s.tab);
    expect(new Set(minted).size).toBe(3);

    // `/clear` in the MIDDLE tab only: the hook reports its new session.
    await submitTo(id, tabIds[1], `#usage session ${CLEARED[1]}`);
    await browser.waitUntil(async () => (await sessions(id))[1].persisted === CLEARED[1],
      { timeout: 10_000, timeoutMsg: "the id reported after /clear was not stored on its tab" });
    let now = await sessions(id);
    expect(now.map(s => s.tab)).toEqual([minted[0], CLEARED[1], minted[2]]);

    // A later prompt in that tab must not put the minted id back.
    await submitTo(id, tabIds[1], "after the clear");
    await browser.pause(500);

    // `/clear` in the other two as well, each with its own id.
    await submitTo(id, tabIds[0], `#usage session ${CLEARED[0]}`);
    await submitTo(id, tabIds[2], `#usage session ${CLEARED[2]}`);
    await browser.waitUntil(async () => (await sessions(id)).every((s, i) => s.persisted === CLEARED[i]),
      { timeout: 10_000, timeoutMsg: "each tab should hold the id reported in its own terminal" });
    now = await sessions(id);
    expect(now.map(s => [s.tab, s.persisted])).toEqual(CLEARED.map(c => [c, c]));
  });

  it("resumes each tab's post-/clear session when the task comes back", async () => {
    const id = taskId!;
    const before = spawnArgv(id).length;
    await browser.execute((t) => {
      const s = window.__termic!.useApp.getState();
      s.stopTask(t);
      s.setActiveTask(null);
    }, id);
    await browser.pause(300);
    await browser.execute((t) => window.__termic!.useApp.getState().setActiveTask(t), id);
    await browser.waitUntil(
      () => Promise.resolve(spawnArgv(id).length >= before + 3),
      { timeout: 30_000, timeoutMsg: "the task did not respawn all three agent tabs" },
    );
    const respawned = spawnArgv(id).slice(before).join("\n");
    for (const c of CLEARED) expect(respawned).toContain(`--resume ${c}`);
    expect(respawned).not.toContain("--session-id");
  });

  it("keeps a /clear that lands before the first prompt, even inside the first two seconds", async () => {
    // The minted id is held only once the spawn survives 2s, and persisted on
    // the first prompt. A /clear before either used to lose to it: the timer
    // armed the minted id after the report, and the first Enter wrote it back.
    const id = taskId!;
    const EARLY = "55555555-6666-4777-8888-999999999999";
    const tb = await browser.execute((t) => {
      const tab = { id: crypto.randomUUID(), type: "terminal", cli: "fakeclaude", title: "FakeClaude" };
      window.__termic!.useApp.getState().addTab(t, tab as never);
      return tab.id;
    }, id);
    tabIds.push(tb);
    const idx = tabIds.length - 1;
    await browser.waitUntil(
      () => browser.execute((t, x) =>
        !!(window.__termic!.useApp.getState().tabs[t] ?? []).find((y: any) => y.id === x)?.lastOutputAt, id, tb),
      { timeout: 30_000, timeoutMsg: "the new agent tab produced no output" },
    );
    await submitTo(id, tb, `#usage session ${EARLY}`);
    await browser.waitUntil(async () => (await sessions(id))[idx].tab === EARLY,
      { timeout: 10_000, timeoutMsg: "the early /clear report was not stored" });
    // Past the survive window, then the first real prompt.
    await browser.pause(SURVIVE_MS);
    await submitTo(id, tb, "first prompt after the clear");
    await browser.pause(500);
    const s = (await sessions(id))[idx];
    expect([s.tab, s.persisted]).toEqual([EARLY, EARLY]);
  });
});

// The same agent, added to a task from the + menu instead of being the task's
// own. That tab is the FIRST of its cli, so every "primary" test in the spawn
// path says yes to it, and it reports and stores a session id exactly like the
// default tab above. What differs is the CLOSE: a secondary agent tab is
// dropped from the durable set on ×, which in a worktree is invisible (the
// next one picks the conversation back up from the cwd) and in the repo root
// is total (there is no cwd fallback there, by design).
describe("a secondary capture-resume tab in the main checkout", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  let taskId: string | null = null;

  function argvFor(id: string): string[] {
    const raw = readFileSync(join(dataDir, "e2e-agent-argv.log"), "utf8");
    return raw.split("\n").filter(l => l.startsWith(id + "\t")).map(l => l.slice(id.length + 1));
  }

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("is forgotten on close, and the Resume list is what carries its session", async () => {
    taskId = await openTask("e2e-capture-secondary", true, "fakeagent");
    const id = taskId;
    await waitForAgentReady(id);

    // "+" → a second agent of a different cli.
    const tabId = await browser.execute((t) => {
      const s = window.__termic!.useApp.getState();
      const tab = { id: crypto.randomUUID(), type: "terminal", cli: "fakecapture", title: "FakeCapture" };
      s.addTab(t, tab as never);
      return tab.id;
    }, id);
    await browser.waitUntil(
      () => browser.execute(
        (t, tb) => !!(window.__termic!.useApp.getState().tabs[t] ?? []).find((x: any) => x.id === tb)?.lastOutputAt,
        id, tabId,
      ),
      { timeout: 30_000, timeoutMsg: "the secondary agent never produced output" },
    );
    // Stand in for the agent's own report, which the first describe proves
    // end to end through the real OSC. `submitToAgent` drives the task's
    // VISIBLE terminal and guards on tab[0], so it cannot speak to a second
    // tab; the question here is what the CLOSE does to a stored id, not how
    // the id got stored.
    await browser.execute((t, tb, sid) => {
      window.__termic!.useApp.getState().setTabSessionId(t, tb, sid);
    }, id, tabId, SESSION);
    await browser.waitUntil(
      () => browser.execute(
        (t, tb) => (window.__termic!.useApp.getState().tabs[t] ?? []).find((x: any) => x.id === tb)?.sessionId ?? null,
        id, tabId,
      ).then(v => v === SESSION),
      { timeout: 20_000, timeoutMsg: "the secondary agent's session id was not stored" },
    );

    // It IS in the durable set while open.
    expect(await browser.execute(
      (t, tb) => (window.__termic!.useApp.getState().tasks.find((w: any) => w.id === t)
        ?.persisted_tabs ?? []).some((p: any) => p.id === tb && p.session_id),
      id, tabId,
    )).toBe(true);

    const before = argvFor(id).length;
    await browser.execute((t, tb) => window.__termic!.useApp.getState().closeTab(t, tb), id, tabId);

    // Closing it FORGETS it: nothing durable is left pointing at the session.
    expect(await browser.execute(
      (t) => (window.__termic!.useApp.getState().tasks.find((w: any) => w.id === t)
        ?.persisted_tabs ?? []).map((p: any) => p.cli),
      id,
    )).not.toContain("fakecapture");

    // Open another one from the + menu: a new tab, so a fresh session.
    await browser.execute((t) => {
      const s = window.__termic!.useApp.getState();
      s.addTab(t, { id: crypto.randomUUID(), type: "terminal", cli: "fakecapture", title: "FakeCapture" } as never);
    }, id);
    await browser.waitUntil(
      () => Promise.resolve(argvFor(id).length > before),
      { timeout: 30_000, timeoutMsg: "the replacement tab never spawned" },
    );
    // A NEW tab is a new session: no resume block, and in the repo root no cwd
    // fallback either, so this agent genuinely starts from nothing. That is
    // the × contract for a secondary tab and it is not the bug.
    expect(argvFor(id)[argvFor(id).length - 1]).not.toContain("resume");

    // The way back is the + menu's Resume list, which still holds the session.
    const entry = await browser.execute(
      (t) => (window.__termic!.useApp.getState().closedTabs[t] ?? [])[0] ?? null, id);
    expect(entry).toMatchObject({ cli: "fakecapture", sessionId: SESSION, tabId });
    const at = argvFor(id).length;
    await browser.execute((t, e) => {
      window.__termic!.useApp.getState().resumeClosedTab(t, e);
    }, id, (entry as { id: string }).id);
    await browser.waitUntil(
      () => Promise.resolve(argvFor(id).length > at),
      { timeout: 30_000, timeoutMsg: "the resumed tab never spawned" },
    );
    expect(argvFor(id)[argvFor(id).length - 1]).toContain(`resume ${SESSION}`);
  });
});

// The task's OWN agent tab, closed while ANOTHER main tab is still open.
//
// Closing the main agent is documented as "end it for now": the durable entry
// survives and the session comes back when the task wakes. That last clause is
// the catch, and it is invisible until you look for it: waking is what
// `ensureDefaultTab` does, and `ensureDefaultTab` no-ops while the task owns
// any main tab at all. A shell, a Run tab or a diff left open is enough.
//
// So the entry stays on disk, correct and complete, and nothing can reach it:
// it is excluded from the + menu's Resume list precisely BECAUSE it is
// supposed to auto-resume, and the + menu's own "new agent" makes a tab with a
// fresh id. In a worktree the replacement quietly picks the conversation back
// up from the cwd. In the main checkout, where cwd resume is off by design,
// the agent comes back with nothing and no message.
describe("closing the main agent tab while another tab is open", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  let taskId: string | null = null;

  function argvFor(id: string): string[] {
    const raw = readFileSync(join(dataDir, "e2e-agent-argv.log"), "utf8");
    return raw.split("\n").filter(l => l.startsWith(id + "\t")).map(l => l.slice(id.length + 1));
  }

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("is not restored by waking the task, so it goes in the Resume list", async () => {
    taskId = await openTask("e2e-capture-stranded", true, "fakecapture");
    const id = taskId;
    await waitForAgentReady(id);
    const agentTab = await browser.execute(
      (t) => (window.__termic!.useApp.getState().tabs[t] ?? [])[0]?.id as string, id);
    await browser.execute((t, tb, sid) => {
      window.__termic!.useApp.getState().setTabSessionId(t, tb, sid);
    }, id, agentTab, SESSION);

    // A plain shell alongside it — the ordinary thing to have open.
    await browser.execute((t) => {
      window.__termic!.useApp.getState().addTab(t, {
        id: crypto.randomUUID(), type: "terminal", cli: "shell", title: "shell",
      } as never);
    }, id);

    await browser.execute((t, tb) => window.__termic!.useApp.getState().closeTab(t, tb), id, agentTab);

    // The shell keeps the task awake, so the promised route does nothing: this
    // is the hole. Assert it, so a future change that makes waking work here
    // has to come and say so.
    const before = argvFor(id).length;
    await browser.execute((t) => {
      window.__termic!.useApp.getState().ensureDefaultTab(t, "fakecapture");
    }, id);
    expect(await browser.execute(
      (t) => (window.__termic!.useApp.getState().tabs[t] ?? []).map((x: { cli: string }) => x.cli), id,
    )).toEqual(["shell"]);
    expect(argvFor(id)).toHaveLength(before);

    // So the close put it in the Resume list instead, under its own tab id and
    // still flagged as the task's agent.
    const entry = await browser.execute(
      (t) => (window.__termic!.useApp.getState().closedTabs[t] ?? [])[0] ?? null, id);
    expect(entry).toMatchObject({ tabId: agentTab, isDefault: true, sessionId: SESSION });

    await browser.execute((t, e) => {
      window.__termic!.useApp.getState().resumeClosedTab(t, e);
    }, id, (entry as { id: string }).id);
    await browser.waitUntil(
      () => Promise.resolve(argvFor(id).length > before),
      { timeout: 30_000, timeoutMsg: "the resumed main agent never spawned" },
    );
    expect(argvFor(id)[argvFor(id).length - 1]).toContain(`resume ${SESSION}`);

    // Back as the task's agent, on its original tab id, with ONE durable
    // record for that session rather than a second one beside it.
    expect(await browser.execute((t) => {
      const st = window.__termic!.useApp.getState();
      const durable = (st.tasks.find((w: { id: string }) => w.id === t) as
        { persisted_tabs?: { id: string; session_id?: string | null; is_default?: boolean }[] })
        ?.persisted_tabs ?? [];
      return durable.filter(d => d.session_id).map(d => ({ id: d.id, def: !!d.is_default }));
    }, id)).toEqual([{ id: agentTab, def: true }]);
  });
});
