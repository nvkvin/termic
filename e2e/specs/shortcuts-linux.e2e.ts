// Shortcuts on Linux, pressed for real.
//
// Every other spec sends keys through WebDriver, which builds a KeyboardEvent
// in the page: it carries whatever modifiers the spec asked for, so it cannot
// see what WebKitGTK does to a real key. Two things it does broke shortcuts
// here and no synthetic key would have shown either:
//
//   * Super is never reported as a modifier. Super+J arrives as a bare "j"
//     with metaKey false, so the Windows convention (Win+J toggles the
//     terminal from inside a terminal, where Ctrl+J belongs to the shell) did
//     nothing, and the j was typed into the agent.
//   * Shift+Tab arrives as key "Unidentified" (X's ISO_Left_Tab keysym), so
//     Ctrl+Shift+Tab never walked backwards.
//
// So this spec presses keys through the X server with xdotool. Linux only,
// and only where xdotool can reach the window: an X display (Xvfb in CI,
// XWayland with GDK_BACKEND=x11 locally). Skipped everywhere else.
//
// What it cannot see: the desktop's own grabs. GNOME keeps Super+L, Super+D,
// Super+N, Super+P, Super+O and Super+1-9 for itself and those never reach
// any application. The display this runs on has no window manager, so every
// chord arrives. docs/shortcuts.md lists the ones a real desktop takes.

import { execFileSync } from "node:child_process";
import { archiveTask, openTask, requireTermicApi, snap, waitForAgentReady, waitForAppShell } from "../helpers";

const xdo = (...args: string[]): string =>
  execFileSync("xdotool", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const canPress = (() => {
  if (process.platform !== "linux" || !process.env.DISPLAY) return false;
  // On a Wayland session GTK only uses X when told to.
  if (process.env.WAYLAND_DISPLAY && process.env.GDK_BACKEND !== "x11") return false;
  try { xdo("version"); return true; } catch { return false; }
})();

/** A binding's key as an X keysym name. */
const KEYSYM: Record<string, string> = {
  "[": "bracketleft", "]": "bracketright", ",": "comma", "=": "equal", "-": "minus",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};
/** Function keys go by KEYCODE. Asked for "F12" by name, xdotool finds the
 *  keysym on a shifted level of the key (next to the VT-switch symbols) and
 *  adds Alt to reach it, which is a different chord. */
const F_KEYCODE: Record<string, string> = {
  F1: "67", F2: "68", F3: "69", F4: "70", F5: "71", F6: "72", F7: "73", F8: "74", F9: "75", F10: "76", F11: "95", F12: "96",
};
const keysym = (key: string) => (key === "1-9" ? "3" : F_KEYCODE[key] ?? KEYSYM[key] ?? key);

type Binding = { key: string; cmd: boolean; shift: boolean; alt: boolean };
type Seen = { key: string; code: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean };

/** Press a chord as a person does: modifiers down, the key, modifiers up. */
function press(mods: string[], key: string): void {
  for (const m of mods) xdo("keydown", m);
  xdo("key", key);
  for (const m of [...mods].reverse()) xdo("keyup", m);
}

/** Give the app's window the X input focus and click `selector`'s centre, so
 *  focus is where a user's click would have put it. */
async function clickFor(selector: string): Promise<void> {
  const at = await browser.execute((sel) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector) as { x: number; y: number } | null;
  if (!at) throw new Error(`clickFor: nothing visible matches ${selector}`);
  const { win, x, y } = appWindow();
  xdo("windowfocus", win);
  xdo("mousemove", String(x + at.x), String(y + at.y), "click", "1");
}

/** The app's top-level X window and where it sits. GTK creates a few small
 *  helper windows under the same class, so take the biggest. */
function appWindow(): { win: string; x: number; y: number } {
  const ids = xdo("search", "--onlyvisible", "--class", "termic").split("\n").filter(Boolean);
  let best = { win: "", x: 0, y: 0, area: -1 };
  for (const win of ids) {
    const geo = Object.fromEntries(
      xdo("getwindowgeometry", "--shell", win).split("\n").map(l => l.split("=") as [string, string]),
    );
    const area = Number(geo.WIDTH) * Number(geo.HEIGHT);
    if (area > best.area) best = { win, x: Number(geo.X), y: Number(geo.Y), area };
  }
  if (!best.win) throw new Error("no visible X window with class termic");
  return best;
}

/** Stand in front of the app's own handler: record every keydown that
 *  bubbles out of the focused element, and stop it there, so the audit can
 *  press Ctrl+W forty times without closing anything. A key the terminal
 *  kept for the shell never gets this far, which is the thing measured. */
const intercept = (on: boolean) => browser.execute((enable) => {
  const w = window as unknown as { __keys?: Seen[]; __keyTrap?: (e: KeyboardEvent) => void };
  if (w.__keyTrap) document.removeEventListener("keydown", w.__keyTrap);
  w.__keyTrap = undefined;
  w.__keys = [];
  if (!enable) return;
  w.__keyTrap = (e: KeyboardEvent) => {
    if (["Control", "Shift", "Alt", "Meta", "Super", "OS"].includes(e.key)) return;
    w.__keys!.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener("keydown", w.__keyTrap);
}, on);

const seen = () => browser.execute(
  () => (window as unknown as { __keys?: Seen[] }).__keys ?? [],
) as unknown as Promise<Seen[]>;

/** Bytes the page has written to any PTY since the last call. */
const ptyBytes = () => browser.execute(() => {
  const w = window as unknown as { __ptyOut?: number[] };
  const out = w.__ptyOut ?? [];
  w.__ptyOut = [];
  return out;
}) as unknown as Promise<number[]>;

(canPress ? describe : describe.skip)("shortcuts on Linux, with real keys", () => {
  let taskId = "";
  let bindings: Record<string, Binding> = {};
  const TERMINAL = ".xterm-screen";

  before(async function () {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-keys");
    await waitForAgentReady(taskId);
    bindings = await browser.execute(
      () => window.__termic!.usePrefs.getState().shortcuts,
    ) as unknown as Record<string, Binding>;
    // Watch what reaches a PTY: the proof that Super+J is not also a typed j.
    // At `fetch`, because that is where a Tauri command leaves the page on
    // Linux (`ipc://localhost/<command>`) and `__TAURI_INTERNALS__.invoke`
    // itself is neither writable nor configurable.
    await browser.execute(() => {
      const w = window as unknown as { __ptyOut?: number[] };
      w.__ptyOut = [];
      const real = window.fetch;
      window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        try {
          const url = String((input as Request).url ?? input);
          if (url.endsWith("/pty_write") && typeof init?.body === "string") {
            w.__ptyOut!.push(...(JSON.parse(init.body).data as number[]));
          }
        } catch { /* not ours to break */ }
        return real.call(this, input, init);
      } as typeof window.fetch;
    });
  });

  after(async () => {
    if (!canPress) return;
    await intercept(false);
    // Not optional here. The audit presses every chord in the table, and the
    // ones a terminal handles itself (split, new shell) take effect before
    // anything can stand in front of them, so this task ends with a pile of
    // panes and shells. Left behind, it failed tabs-layout's menu and split
    // cases whenever that file ran after this one, and archiving it here is
    // what fixed them (run both ways).
    if (taskId) await archiveTask(taskId);
  });

  it("a plain key typed in a terminal reaches the shell, and nothing else", async () => {
    // The control for everything below: the rig types into the PTY at all.
    await clickFor(TERMINAL);
    await ptyBytes();
    press([], "j");
    await browser.waitUntil(async () => (await ptyBytes()).includes(0x6a), {
      timeout: 5_000, timeoutMsg: "a real j never reached the PTY, so the rig is not typing into the terminal",
    });
  });

  it("Super+J toggles the terminal panel from inside a terminal, and types no j", async () => {
    const split = () => browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      return !!s.terminalSplit[id] && !s.terminalSplitCollapsed[id];
    }, taskId) as unknown as Promise<boolean>;
    await clickFor(TERMINAL);
    await ptyBytes();
    const was = await split();
    press(["Super_L"], "j");
    await browser.waitUntil(async () => (await split()) !== was, {
      timeout: 5_000, timeoutMsg: "Super+J did not toggle the terminal panel",
    });
    expect(await ptyBytes()).not.toContain(0x6a);
    await snap("shortcuts-linux-super-j.png");
    // And the release is seen: the next j is text again, not a shortcut.
    await clickFor(TERMINAL);
    await ptyBytes();
    const now = await split();
    press([], "j");
    await browser.waitUntil(async () => (await ptyBytes()).includes(0x6a), {
      timeout: 5_000, timeoutMsg: "after releasing Super, j was no longer typed",
    });
    expect(await split()).toBe(now);
  });

  it("Ctrl+J in a terminal stays the shell's", async () => {
    await clickFor(TERMINAL);
    await intercept(true);
    await ptyBytes();
    press(["Control_L"], "j");
    // Line feed to the PTY, and the app's handler never hears of it.
    await browser.waitUntil(async () => (await ptyBytes()).includes(0x0a), {
      timeout: 5_000, timeoutMsg: "Ctrl+J did not reach the PTY as a line feed",
    });
    expect(await seen()).toEqual([]);
    await intercept(false);
  });

  it("Shift+Tab is still Tab, so Ctrl+Shift+Tab can walk backwards", async () => {
    await clickFor(TERMINAL);
    // Capture phase, before the tab walk claims it: what the key IS.
    await browser.execute(() => {
      const w = window as unknown as { __tab?: { key: string; code: string } };
      w.__tab = undefined;
      window.addEventListener("keydown", function once(e) {
        if (e.code !== "Tab") return;
        w.__tab = { key: e.key, code: e.code };
        window.removeEventListener("keydown", once, true);
      }, true);
    });
    press(["Control_L", "Shift_L"], "Tab");
    const tab = await browser.waitUntil(
      () => browser.execute(() => (window as unknown as { __tab?: { key: string; code: string } }).__tab),
      { timeout: 5_000, timeoutMsg: "Ctrl+Shift+Tab never arrived" },
    ) as { key: string; code: string };
    // The reason isTabKey reads `code`. If WebKitGTK ever reports "Tab" here
    // this still passes, and the fallback is merely unused.
    expect(tab.code).toBe("Tab");
    expect(["Tab", "Unidentified"]).toContain(tab.key);
  });

  it("Shift+[ and Shift+] switch tabs, though the keys arrive as { and }", async () => {
    // Two scratch shells in the bottom split, and the focus in one of them:
    // previous / next tab then cycles those.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      while ((window.__termic!.useApp.getState().bottomTabs[id] ?? []).length < 2) app.addBottomTab(id);
      const s = window.__termic!.useApp.getState();
      if (!s.terminalSplit[id] || s.terminalSplitCollapsed[id]) s.toggleBottomTerminal(id);
    }, taskId);
    const BOTTOM = "[data-bottom-split] .xterm-screen";
    const active = () => browser.execute(
      (id) => window.__termic!.useApp.getState().activeBottomTab[id] as string, taskId,
    ) as unknown as Promise<string>;
    await browser.waitUntil(
      () => browser.execute((sel) => !!document.querySelector(sel), BOTTOM),
      { timeout: 10_000, timeoutMsg: "the bottom split never showed a terminal" },
    );
    await clickFor(BOTTOM);
    const first = await active();
    press(["Control_L", "Shift_L"], "bracketright");
    await browser.waitUntil(async () => (await active()) !== first, {
      timeout: 5_000, timeoutMsg: "Ctrl+Shift+] did not move to the next tab",
    });
    await clickFor(BOTTOM);
    press(["Super_L", "Shift_L"], "bracketleft");
    await browser.waitUntil(async () => (await active()) === first, {
      timeout: 5_000, timeoutMsg: "Super+Shift+[ did not move back to the previous tab",
    });
  });

  /** The physical key a binding names, as `KeyboardEvent.code`. Attribution
   *  goes by this and not by arrival order: a chord the terminal swallows
   *  leaves nothing, and the next chord's event must not be counted as its. */
  const codeOf = (key: string): string => {
    if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (key === "1-9") return "Digit3";
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    return ({ "[": "BracketLeft", "]": "BracketRight", ",": "Comma", "=": "Equal", "-": "Minus" } as Record<string, string>)[key] ?? key;
  };

  /** `bindingMatches`, restated: the app's matcher is not on `__termic`, and
   *  this is the question the audit asks of each REAL event. */
  const wouldMatch = (e: Seen, b: Binding, superHeld: boolean): boolean => {
    if ((e.meta || e.ctrl || superHeld) !== b.cmd || e.shift !== b.shift || e.alt !== b.alt) return false;
    if (b.key === "1-9") return /^[1-9]$/.test(e.key);
    // Shift turns `[` into `{`; the matcher takes that back out (UNSHIFTED in
    // lib/shortcuts.ts). The real thing is exercised by the tab case below.
    const unshift = (k: string, shift: boolean) =>
      shift ? ({ "{": "[", "}": "]", "<": ",", "+": "=", "_": "-" } as Record<string, string>)[k] ?? k : k;
    const token = /^[a-zA-Z]$/.test(e.key) ? e.key.toLowerCase() : unshift(e.key, e.shift);
    return token === unshift(b.key, b.shift);
  };

  /** Press one binding's chord in the focused terminal and say what became
   *  of it: nothing bubbled out ("kept"), or the event that did. */
  async function pressBinding(b: Binding, cmdKey: "Super_L" | "Control_L"): Promise<Seen | null> {
    const mods = [cmdKey, ...(b.shift ? ["Shift_L"] : []), ...(b.alt ? ["Alt_L"] : [])];
    // Every time, not once before the loop: a chord the terminal handles
    // itself can move the focus (its find bar takes it), and every chord
    // after that would be measured from somewhere else.
    await clickFor(TERMINAL);
    await intercept(true);
    press(mods, keysym(b.key));
    const code = codeOf(b.key);
    try {
      return await browser.waitUntil(
        async () => (await seen()).find(e => e.code === code) ?? false,
        { timeout: 1_200, interval: 60 },
      ) as Seen;
    } catch { return null; }
  }

  it("every binding fires from inside a terminal with Super", async () => {
    await clickFor(TERMINAL);
    const kept: string[] = [];
    const unmatched: string[] = [];
    for (const [id, b] of Object.entries(bindings).sort()) {
      // A binding with no Cmd in it has no Super form.
      if (!b.cmd) continue;
      const e = await pressBinding(b, "Super_L");
      if (!e) kept.push(id);
      else if (!wouldMatch(e, b, true)) unmatched.push(`${id} (arrived as key ${JSON.stringify(e.key)})`);
    }
    await intercept(false);
    console.log(`\nSuper+<binding> from a focused terminal:\n  kept by the terminal: ${kept.join(", ") || "none"}\n  arrived but would not match: ${unmatched.join(", ") || "none"}\n`);
    // Handled by the terminal itself before the app's handler, by design:
    // copy / paste, and Shift+F which is the terminal's own find there.
    const local = new Set(["terminal-copy", "terminal-paste", "find-in-files"]);
    expect(kept.filter(id => !local.has(id))).toEqual([]);
    expect(unmatched).toEqual([]);
  });

  it("with Ctrl, the terminal keeps the shell's letters and nothing arrives mangled", async () => {
    await clickFor(TERMINAL);
    const kept: string[] = [];
    const unmatched: string[] = [];
    for (const [id, b] of Object.entries(bindings).sort()) {
      if (!b.cmd) continue;
      const e = await pressBinding(b, "Control_L");
      if (!e) kept.push(id);
      else if (!wouldMatch(e, b, false)) unmatched.push(`${id} (arrived as key ${JSON.stringify(e.key)})`);
    }
    await intercept(false);
    console.log(`\nCtrl+<binding> from a focused terminal:\n  kept by the terminal: ${kept.join(", ")}\n  arrived but would not match: ${unmatched.join(", ") || "none"}\n`);
    // The rule the terminal is written to (TerminalPane's PASS_TO_APP): a
    // plain Ctrl+letter is readline's. Ctrl+J, Ctrl+L, Ctrl+P, Ctrl+O and
    // Ctrl+B are all line editing, and taking them would break the prompt.
    // These are exactly the shortcuts Super exists for.
    for (const id of ["toggle-terminal", "focus-terminal", "file-finder", "task-finder", "toggle-left-sidebar"]) {
      expect(kept).toContain(id);
    }
    expect(unmatched).toEqual([]);
  });
});
