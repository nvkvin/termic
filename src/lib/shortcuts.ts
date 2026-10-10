// Single source of truth for the app's rebindable keyboard shortcuts.
//
// Each command has a stable `id`, a human label + group (for the Shortcuts
// settings page), and a `defaultBinding`. The live handler in
// `src/hooks/useShortcuts.ts` matches incoming KeyboardEvents against the
// RESOLVED bindings (defaults merged with the user's overrides, persisted in
// the prefs store) — so adding a command here + a case there is all it takes
// to make it configurable.
//
// Modifier model mirrors the handler's long-standing one: `cmd` is true for
// EITHER Cmd or Ctrl (the app folds the two together), `shift` / `alt` are
// their own flags. `key` is a normalized token: a lowercase letter ("l"),
// punctuation ("[", "]", ","), an arrow ("ArrowUp"…), or the sentinel "1-9"
// for the "jump to tab N" range (matches any digit 1-9 with the modifiers).
import { IS_LINUX, IS_MAC, kbd } from "./platform";

export type Binding = {
  cmd: boolean;
  shift: boolean;
  alt: boolean;
  /** Normalized key token. See module header. */
  key: string;
};

export type ShortcutId =
  | "sidebar-prev"
  | "sidebar-next"
  | "nav-back"
  | "nav-forward"
  | "task-prev-arrow"
  | "task-next-arrow"
  | "jump-next-waiting"
  | "tab-prev"
  | "tab-next"
  | "tab-prev-arrow"
  | "tab-next-arrow"
  | "jump-to-tab"
  | "focus-terminal"
  | "new-tab"
  | "new-scratchpad"
  | "close-tab"
  | "clear-terminal"
  | "split-pane-right"
  | "split-pane-below"
  | "toggle-terminal"
  | "terminal-copy"
  | "terminal-paste"
  | "new-task-quick"
  | "command-palette"
  | "open-settings"
  | "file-finder"
  | "task-finder"
  | "find-in-files"
  | "toggle-left-sidebar"
  | "toggle-right-sidebar"
  | "broadcast"
  | "prompt-palette"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "create-pr"
  | "stage-file"
  | "discard-file"
  | "add-selection-to-agent"
  | "go-to-definition"
  | "find-usages"
  | "go-to-implementation"
  | "go-to-type-definition"
  | "file-structure";

export type ShortcutGroup =
  | "Navigation" | "Code navigation" | "Tabs" | "Terminal" | "Git" | "General";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBinding: Binding;
  /** Help text shown under the label in the settings list. */
  hint?: string;
}

const B = (key: string, mods: Partial<Omit<Binding, "key">> = {}): Binding => ({
  cmd: !!mods.cmd,
  shift: !!mods.shift,
  alt: !!mods.alt,
  key,
});

// Order here = display order in the settings page (grouped by `group`).
export const SHORTCUT_DEFS: ShortcutDef[] = [
  // Navigation
  { id: "sidebar-prev", group: "Navigation", label: "Previous sidebar row",
    hint: "Task or expanded tab above", defaultBinding: B("ArrowUp", { alt: true }) },
  { id: "sidebar-next", group: "Navigation", label: "Next sidebar row",
    hint: "Task or expanded tab below", defaultBinding: B("ArrowDown", { alt: true }) },
  // ⌘[ / ⌘] mean BACK and FORWARD, and nothing else.
  //
  // They used to switch tasks as well, with the folder listing and then the
  // jump trail claiming them conditionally on top — three meanings for one
  // chord, decided by where the focus happened to be. Switching tasks was the
  // redundant one: ⌥⌘↑ / ⌥⌘↓ already do it (and do it in a split too), and
  // tabs have ⇧⌘[ / ⇧⌘]. One key, one idea: go back to where I just was.
  { id: "nav-back", group: "Navigation", label: "Back",
    hint: "Where you came from: the previous symbol you jumped from, or the folder you were just in.",
    defaultBinding: B("[", { cmd: true }) },
  // Code navigation (GH #174). These fire only while an editor has focus, and
  // only on a checkout the reader has switched it on for; they are listed here
  // like any other key, because a shortcut nobody can find is a feature nobody
  // has. The defaults are IntelliJ's, which is where most of this app's users
  // learned them.
  { id: "go-to-definition", group: "Code navigation", label: "Go to definition",
    hint: `In the editor. Lands on the source, not a stub; ${kbd("⌘")}-click does the same.`,
    defaultBinding: B("F12") },
  { id: "find-usages", group: "Code navigation", label: "Find usages",
    hint: `In the editor. ${kbd("⌘")}-clicking a definition asks the same question.`,
    defaultBinding: B("F12", { shift: true }) },
  // NOT IntelliJ's ⌥⌘B and ⌃⇧B. ⌥⌘B already toggles the right sidebar here,
  // and the editor's copy of it fired on top of that (this table's own
  // duplicate-chord test is what surfaced it). ⌃⇧B cannot be expressed at all:
  // a Binding folds Ctrl into Cmd, so on a Mac it would read as ⌘⇧B.
  { id: "go-to-implementation", group: "Code navigation", label: "Go to implementation",
    hint: "From an interface or an abstract method to what implements it.",
    defaultBinding: B("b", { alt: true, shift: true }) },
  { id: "go-to-type-definition", group: "Code navigation", label: "Go to type definition",
    hint: "From a value to the type it has.",
    defaultBinding: B("t", { alt: true, shift: true }) },
  { id: "file-structure", group: "Code navigation", label: "File structure",
    hint: "What is in this file, filterable, without scrolling it.",
    defaultBinding: B("F12", { cmd: true }) },
  { id: "nav-forward", group: "Navigation", label: "Forward",
    hint: "Retrace a Back.",
    defaultBinding: B("]", { cmd: true }) },
  { id: "task-prev-arrow", group: "Navigation", label: "Pane up / previous task",
    hint: "With a horizontal split: focus the pane above. Otherwise: go to the previous task.",
    defaultBinding: B("ArrowUp", { cmd: true, alt: true }) },
  { id: "task-next-arrow", group: "Navigation", label: "Pane down / next task",
    hint: "With a horizontal split: focus the pane below. Otherwise: go to the next task.",
    defaultBinding: B("ArrowDown", { cmd: true, alt: true }) },
  { id: "jump-next-waiting", group: "Navigation", label: "Jump to next waiting agent",
    hint: "Cycle to the next task whose agent is waiting on you (finished a turn or blocked on input). Visiting clears the signal, so repeated presses walk your whole queue.",
    defaultBinding: B("a", { cmd: true, shift: true }) },

  // Tabs
  { id: "tab-prev", group: "Tabs", label: "Previous tab",
    defaultBinding: B("[", { cmd: true, shift: true }) },
  { id: "tab-next", group: "Tabs", label: "Next tab",
    defaultBinding: B("]", { cmd: true, shift: true }) },
  { id: "tab-prev-arrow", group: "Tabs", label: "Pane left",
    hint: "With a vertical split: focus the pane to the left. No-op otherwise.",
    defaultBinding: B("ArrowLeft", { cmd: true, alt: true }) },
  { id: "tab-next-arrow", group: "Tabs", label: "Pane right",
    hint: "With a vertical split: focus the pane to the right. No-op otherwise.",
    defaultBinding: B("ArrowRight", { cmd: true, alt: true }) },
  { id: "jump-to-tab", group: "Tabs", label: "Jump to tab 1…9",
    hint: "Modifier + a number key", defaultBinding: B("1-9", { cmd: true }) },
  { id: "new-tab", group: "Tabs", label: "New tab",
    defaultBinding: B("t", { cmd: true }) },
  { id: "new-scratchpad", group: "Tabs", label: "New scratchpad",
    // NOT ⌘N — that is already "New task…" and stealing it would cost the
    // app's most-used create. ⌥⌘N is free (⌥⌘B and ⌥⌘P are the other two
    // Option-Cmd bindings) and rebindable like everything else.
    hint: `An untitled buffer in this task. It survives a relaunch; ${kbd("⌘S")} saves it into the project.`,
    defaultBinding: B("n", { cmd: true, alt: true }) },
  { id: "close-tab", group: "Tabs", label: "Close active tab",
    defaultBinding: B("w", { cmd: true }) },

  // Terminal
  { id: "focus-terminal", group: "Terminal", label: "Focus main agent",
    hint: "Jump focus to the main pane (its agent terminal or the open editor) from anywhere",
    defaultBinding: B("l", { cmd: true }) },
  { id: "clear-terminal", group: "Terminal", label: "Clear focused terminal",
    hint: `Clears the focused terminal's scrollback, the standard ${kbd("⌘K")} every terminal uses.`,
    defaultBinding: B("k", { cmd: true }) },
  { id: "split-pane-right", group: "Terminal", label: "Split pane right",
    hint: "Open a new pane to the right of the focused pane (vertical divider).",
    defaultBinding: B("d", { cmd: true }) },
  { id: "split-pane-below", group: "Terminal", label: "Split pane below",
    hint: `Open a new pane below the focused pane (horizontal divider). Also: ${kbd("⇧⌘D")} by default.`,
    defaultBinding: B("d", { cmd: true, shift: true }) },
  { id: "toggle-terminal", group: "Terminal", label: "Toggle terminal panel",
    hint: "Show + focus the bottom split, or hide it and return to the agent",
    defaultBinding: B("j", { cmd: true }) },
  // Copy / paste are LINUX/WINDOWS ONLY and handled locally in the terminal
  // panes (TerminalPane / AuxTerminal `attachCustomKeyEventHandler`), gated to
  // !IS_MAC, NOT by the global useShortcuts handler (like the Git ids below,
  // they have no `switch` case there). macOS keeps native ⌘C / ⌘V untouched, so
  // these rows are hidden from the Shortcuts settings on macOS. The Shift in the
  // defaults is load-bearing: plain Ctrl+C must stay SIGINT for the shell.
  { id: "terminal-copy", group: "Terminal", label: "Copy selection",
    hint: "Linux/Windows only. macOS uses Cmd+C natively.",
    defaultBinding: B("c", { cmd: true, shift: true }) },
  { id: "terminal-paste", group: "Terminal", label: "Paste into terminal",
    hint: "Linux/Windows only. macOS uses Cmd+V natively.",
    defaultBinding: B("v", { cmd: true, shift: true }) },

  // General
  { id: "command-palette", group: "General", label: "Command palette",
    hint: `Search every command and action (the ${kbd("⇧⌘P")} convention from VS Code / Sublime)`,
    defaultBinding: B("p", { cmd: true, shift: true }) },
  { id: "new-task-quick", group: "General", label: "New task…",
    hint: "Search a project and start a new task", defaultBinding: B("n", { cmd: true }) },
  { id: "open-settings", group: "General", label: "Open settings",
    defaultBinding: B(",", { cmd: true }) },
{ id: "file-finder", group: "General", label: "Open file finder",
    defaultBinding: B("p", { cmd: true }) },
  { id: "task-finder", group: "General", label: "Open task finder",
    hint: "Quick search and switch tasks across projects",
    defaultBinding: B("o", { cmd: true }) },
  { id: "find-in-files", group: "General", label: "Find in files",
    defaultBinding: B("f", { cmd: true, shift: true }) },
  { id: "toggle-left-sidebar", group: "General", label: "Toggle left sidebar",
    hint: "Collapse / expand the projects sidebar", defaultBinding: B("b", { cmd: true }) },
  { id: "toggle-right-sidebar", group: "General", label: "Toggle right sidebar",
    hint: "Show / hide the right panel", defaultBinding: B("b", { cmd: true, alt: true }) },
  { id: "broadcast", group: "General", label: "Broadcast to agents",
    defaultBinding: B("b", { cmd: true, shift: true }) },
  { id: "prompt-palette", group: "General", label: "Prompt palette",
    hint: "Search prompts by title; digits 1-9 fire the top rows, Enter runs the highlighted one",
    defaultBinding: B("p", { cmd: true, alt: true }) },
  { id: "zoom-in", group: "General", label: "Zoom in",
    hint: "Scale the whole app up (like browser zoom)", defaultBinding: B("=", { cmd: true }) },
  { id: "zoom-out", group: "General", label: "Zoom out",
    hint: "Scale the whole app down", defaultBinding: B("-", { cmd: true }) },
  { id: "zoom-reset", group: "General", label: "Reset zoom",
    hint: "Return the app to 100%", defaultBinding: B("0", { cmd: true }) },
  // Contextual (editor): handled in EditorPane, not the global switch, and
  // only when that editor holds focus AND has a non-empty selection. Any
  // other time the key falls through untouched. ⇧⌘L is the convention every
  // agent-first editor landed on for this (Cursor's "Add selection to Chat",
  // VS Code Copilot's "Add Selection to Chat"), and it sits next to termic's
  // own ⌘L "focus main agent".
  { id: "add-selection-to-agent", group: "General", label: "Add selection to agent",
    hint: "Opens a comment on the selected lines. Comments queue up and go to the agent as one batch, so you can mark several places before sending.",
    defaultBinding: B("l", { cmd: true, shift: true }) },

  { id: "create-pr", group: "Git", label: "Create pull request",
    hint: "Opens the Create PR / MR dialog for the active task",
    defaultBinding: B("r", { cmd: true, alt: true }) },

  // Git — contextual: these act on the file selected in the Git panel and
  // are handled there (GitPanel), not the global handler. The discard
  // binding deliberately shares ⇧⌘D with the bottom-split terminal; the
  // Git panel only claims it while a file is selected, so the settings
  // "conflict" note is expected.
  { id: "stage-file", group: "Git", label: "Stage / unstage selected file",
    hint: "Toggles the Git panel's selected file in or out of staging",
    defaultBinding: B("s", { cmd: true }) },
  { id: "discard-file", group: "Git", label: "Discard selected file",
    hint: "Restores the selected file to HEAD after a confirm",
    defaultBinding: B("d", { cmd: true, shift: true }) },
];

export const GROUP_ORDER: ShortcutGroup[] =
  ["Navigation", "Code navigation", "Tabs", "Terminal", "Git", "General"];

/**
 * Shortcuts that exist, are worth finding, and cannot be rebound.
 *
 * Kept OUT of `SHORTCUT_DEFS` deliberately. Everything there is a `Binding`,
 * and a Binding is one chord: the bindings map, the conflict check, the
 * recorder in Settings and the localStorage migration all assume it. A def
 * with no binding would have to be special-cased in each of them.
 *
 * So: a small separate list, rendered read-only in the help sheet and in
 * Settings, with its keys spelled out rather than derived. Discoverability is
 * the point; a gesture nobody can find is a feature nobody has.
 */
export interface FixedShortcut {
  id: string;
  group: ShortcutGroup;
  label: string;
  hint: string;
  /** Exactly what is printed, in order. Not derived from a Binding. */
  glyphs: string[];
  /** Why it cannot be changed, shown where the recorder would be. */
  fixedReason: string;
  /** Which mode select this row carries in Settings, if any. The rendering was
   *  `f.id === "search-everywhere"` in five places across two files while there
   *  was only one such row; a second one made that a copy-paste bug waiting to
   *  happen. */
  control?: "double-shift" | "ctrl-tab";
}

export const FIXED_SHORTCUTS: FixedShortcut[] = [
  {
    id: "search-everywhere",
    group: "Code navigation",
    label: "Search everywhere",
    // Says nothing about WHICH Shift: that is the setting's to say, and a
    // hint hardcoding "left" is wrong the moment somebody picks either.
    hint: "Files always; classes and functions too, once a checkout has code navigation on.",
    glyphs: ["⇧", "⇧"],
    fixedReason: "Double tap",
    control: "double-shift",
  },
  {
    id: "recent-tabs",
    group: "Navigation",
    label: "Recently used tabs",
    hint: "Hold Ctrl and tap Tab to step back through what you were looking at; add Shift to go the other way.",
    glyphs: ["⌃", "⇥"],
    fixedReason: "Hold and tap",
    control: "ctrl-tab",
  },
];

/** When the double-Shift gesture opens Search everywhere.
 *
 *    off              never.
 *    left             two taps of the LEFT Shift (the default). The right one
 *                     is what a touch typist holds for left-hand capitals,
 *                     which is where the accidental opens come from.
 *    outside-terminal either Shift, but never while a terminal has focus.
 *    any              either Shift, JetBrains' own behaviour.
 *
 *  Declared HERE rather than in the prefs store: prefs already imports this
 *  module for the bindings, so the other direction would be a cycle. */
export type DoubleShiftMode = "off" | "left" | "outside-terminal" | "any";

/** When double-Shift opens Search everywhere, as the user picks it.
 *
 *  Each label names the WHOLE gesture, because it is the only thing that
 *  does: the row used to print "Double tap, left" beside a select reading
 *  "Left Shift only", so the same gesture was named twice in two different
 *  vocabularies and neither half made sense alone. Off is off, and every
 *  other option says which keys, in the words the reader would use.
 *
 *  Ordered off-to-most-permissive, so the list reads as a dial. Shared by the
 *  Shortcuts page (the select) and the command sheet (which prints the
 *  current one where a recorder would be), so those two cannot disagree. */
export const DOUBLE_SHIFT_MODES: { id: DoubleShiftMode; label: string }[] = [
  { id: "off",              label: "Off" },
  { id: "left",             label: "Double left Shift" },
  { id: "outside-terminal", label: "Double Shift, not in a terminal" },
  { id: "any",              label: "Double Shift" },
];

/** The label for one mode, for a surface that has only the value. */
export function doubleShiftLabel(mode: DoubleShiftMode): string {
  return DOUBLE_SHIFT_MODES.find(m => m.id === mode)?.label ?? mode;
}

/** Whether ⌃⇥ walks the recently-used tabs.
 *
 *  Declared here, next to DOUBLE_SHIFT_MODES and for the same reason: prefs
 *  already imports this module for the bindings, so the other direction would
 *  be a cycle.
 *
 *  On/off rather than the four modes double-Shift needs, because the awkward
 *  question that one answers ("should this fire while I am typing?") has no
 *  equivalent here: Tab with Ctrl held types nothing, and a terminal cannot
 *  tell ⌃⇥ from ⇥ anyway (see the note on the gesture in useShortcuts). */
export type CtrlTabMode = "off" | "on";

/** Each label names the WHOLE gesture, the same rule DOUBLE_SHIFT_MODES follows:
 *  the row prints nothing else beside the select, so "On" alone would leave the
 *  reader to guess what it is on for. */
export const CTRL_TAB_MODES: { id: CtrlTabMode; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "on",  label: "Hold Ctrl, tap Tab" },
];

/** The label for one mode, for a surface that has only the value. */
export function ctrlTabLabel(mode: CtrlTabMode): string {
  return CTRL_TAB_MODES.find(m => m.id === mode)?.label ?? mode;
}

/** Groups of rebindable commands that intentionally share a binding and can
 *  NEVER fire at the same time, so the Shortcuts settings page must not flag
 *  them as conflicts. `split-pane-below` and `discard-file` share ⇧⌘D:
 *  the Git panel captures the key only when a file is selected and
 *  stopPropagation()s, so the terminal handler never sees it in that case. */
export const NON_CONFLICTING_GROUPS: ShortcutId[][] = [
  ["split-pane-below", "discard-file"],
];

export type BindingMap = Record<ShortcutId, Binding>;

export const DEFAULT_BINDINGS: BindingMap = Object.fromEntries(
  SHORTCUT_DEFS.map(d => [d.id, d.defaultBinding]),
) as BindingMap;

// ── Linux: the Super key ────────────────────────────────────────────────
//
// On macOS Cmd is `metaKey`, and on Windows so is the Win key, which is what
// makes Win+J toggle the terminal from INSIDE a terminal: xterm leaves a meta
// chord alone, where it keeps Ctrl+J for the shell (it is a line feed).
//
// WebKitGTK reports none of that. Measured with real X key events (WebKitGTK
// 2.52): holding Super and pressing J delivers a keydown with `key: "j"`,
// `metaKey: false`, and `getModifierState` false for "Super", "OS", "Meta"
// and "Hyper" alike. The chord is indistinguishable from typing a j. What
// DOES arrive is the Super key's own keydown and keyup (`key: "Super"`,
// `code: "OSLeft"` / `"OSRight"`), so the held state is tracked here and
// folded into `cmd` like the other two.
//
// The cost of tracking is a missed keyup: GNOME takes the focus for its
// overview when Super is released alone, and the release can go with it. A
// stuck flag would turn every typed j into a shortcut, so losing focus clears
// it.
let superHeld = false;

function isSuperKey(e: KeyboardEvent): boolean {
  return e.key === "Super" || e.key === "OS" || e.code === "OSLeft" || e.code === "OSRight"
    || e.code === "MetaLeft" || e.code === "MetaRight";
}

if (IS_LINUX && typeof window !== "undefined") {
  // Capture phase: xterm and CodeMirror stop some keys before they bubble.
  window.addEventListener("keydown", e => { if (isSuperKey(e)) superHeld = true; }, true);
  window.addEventListener("keyup", e => { if (isSuperKey(e)) superHeld = false; }, true);
  window.addEventListener("blur", () => { superHeld = false; });
  document.addEventListener("visibilitychange", () => { superHeld = false; });
}

/** Linux only: Super is down, so the key being pressed is an app shortcut
 *  and not text. A terminal asks this to keep the letter out of the PTY. */
export function superIsHeld(): boolean {
  return IS_LINUX && superHeld;
}

/** Test seam: there is no way to hold a key between two synthetic events. */
export function setSuperHeldForTests(v: boolean): void {
  superHeld = v;
}

/** The app's "Cmd" for a live event: Cmd on macOS, Ctrl or the Win key on
 *  Windows, Ctrl or Super on Linux. */
export function eventCmd(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || superIsHeld();
}

const TERMINAL_OWN: ReadonlySet<ShortcutId> = new Set<ShortcutId>(["terminal-copy", "terminal-paste", "find-in-files"]);

/** Off macOS: is this key one of the app's chords that a TERMINAL should let
 *  go? The rule is the one the terminals always stated: Ctrl is the app's
 *  Cmd there, plain Ctrl+letter belongs to the shell (Ctrl+P is readline's
 *  previous line), and a chord that also carries Shift or Alt does not.
 *
 *  It used to be applied to four hand-picked shortcuts, so Ctrl+Alt+Left
 *  (pane left), Ctrl+Alt+P (prompt palette) and every other Ctrl+Alt chord
 *  went to the PTY as an escape sequence instead. That mattered more on
 *  Linux than it looks: GNOME keeps Super+Alt+arrows for itself, so the
 *  Super form of those is not there to fall back on.
 *
 *  Always false on macOS, where Cmd is its own key and the terminals pass a
 *  short explicit list (`PASS_TO_APP`). */
export function isAppChordInTerminal(e: KeyboardEvent, binds: Partial<BindingMap>): boolean {
  if (IS_MAC) return false;
  for (const d of SHORTCUT_DEFS) {
    // The terminal's OWN: copy, paste, and Ctrl+Shift+F, which inside a
    // terminal is that terminal's find. Their handlers sit around the call
    // sites in no fixed order, so they are excluded here, not by position.
    if (TERMINAL_OWN.has(d.id)) continue;
    const b = binds[d.id];
    if (b && b.cmd && (b.shift || b.alt) && bindingMatches(e, b)) return true;
  }
  return false;
}

/** Tab, including Shift+Tab on Linux. X gives Shift+Tab its own keysym
 *  (ISO_Left_Tab) and WebKitGTK reports it as `key: "Unidentified"`, so a
 *  check on `key` alone never saw ⌃⇧⇥ there. `code` is the physical key. */
export function isTabKey(e: KeyboardEvent): boolean {
  return e.key === "Tab" || e.code === "Tab";
}

/** What Shift turns each punctuation key a binding can name into. A binding
 *  says `⇧⌘[`; WebKitGTK (and Chromium on Windows) report the CHARACTER, so
 *  the event says `{` and never matched. Measured with real keys on Linux:
 *  Ctrl+Shift+[ arrived as key "{", and previous / next tab did nothing.
 *  Letters need no entry, they are lower-cased below. */
const UNSHIFTED: Record<string, string> = {
  "{": "[", "}": "]", "<": ",", ">": ".", "+": "=", "_": "-", "?": "/", ":": ";", "\"": "'", "|": "\\", "~": "`",
};

/** A binding's key with Shift's effect on punctuation taken back out, so a
 *  binding recorded as `{` + Shift and one written as `[` + Shift are the
 *  same chord. */
function baseKey(key: string, shift: boolean): string {
  return shift ? UNSHIFTED[key] ?? key : key;
}

/** Normalize a live KeyboardEvent's key to the same token space as `Binding.key`. */
export function eventKeyToken(e: KeyboardEvent): string {
  const k = e.key;
  if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase();
  if (k === "Unidentified" && e.code === "Tab") return "Tab";
  return baseKey(k, e.shiftKey); // ArrowUp / "[" / "]" / "," / digits …
}

/** True when the event's modifiers + key satisfy the binding. The "1-9"
 *  sentinel matches any digit 1-9 with the binding's modifiers. */
export function bindingMatches(e: KeyboardEvent, b: Binding | undefined): boolean {
  if (!b) return false;
  // LINUX/WINDOWS: Ctrl folds into `cmd`, so every shortcut fires there too.
  // Inside a terminal, readline keeps plain Ctrl+letter: xterm consumes those
  // before this handler sees them, and TerminalPane's PASS_TO_APP only takes
  // Shift/Alt bindings off macOS (docs/windows.md, "Keys").
  //
  // AltGr (German, Polish, French layouts) reports as Ctrl+Alt in Chromium,
  // so a key that types `@` or `{` would otherwise fire a Ctrl+Alt binding.
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return false;
  const cmd = eventCmd(e);
  if (cmd !== b.cmd || e.shiftKey !== b.shift || e.altKey !== b.alt) return false;
  if (b.key === "1-9") return /^[1-9]$/.test(e.key);
  return eventKeyToken(e) === baseKey(b.key, b.shift);
}

/** Build a Binding from a recorded keydown. Returns null for a bare modifier
 *  press (no real key yet). `digitMode` collapses a recorded digit into the
 *  "1-9" range sentinel (used by the jump-to-tab row). */
export function bindingFromEvent(e: KeyboardEvent, digitMode = false): Binding | null {
  const k = e.key;
  if (k === "Meta" || k === "Control" || k === "Shift" || k === "Alt" || k === "CapsLock" || isSuperKey(e)) {
    return null;
  }
  let key: string;
  if (/^[a-zA-Z]$/.test(k)) key = k.toLowerCase();
  else if (/^[0-9]$/.test(k)) key = digitMode ? "1-9" : k;
  // Recorded as the key, not the character Shift made of it: `⇧⌘[`, not `⇧⌘{`.
  else key = baseKey(k, e.shiftKey);
  return { cmd: eventCmd(e), shift: e.shiftKey, alt: e.altKey, key };
}

/**
 * Keys the registry refuses outright, whatever modifiers are on them.
 *
 * Tab, because ⌃⇥ is the recently-used-tabs gesture and a `Binding` cannot
 * tell it apart: `bindingMatches` folds Cmd and Ctrl into one flag, so a
 * recorded ⌃⇥ is stored as `{cmd:true, key:"Tab"}` and then fires on every
 * press of the gesture, forever, on top of it. (The ⌘⇥ reading it renders as
 * is dead anyway — macOS owns that one and the webview never sees it.)
 */
export function isReservedKey(key: string): boolean {
  return key === "Tab";
}

/** At least one of Cmd/Ctrl, Option, or Shift+non-alphanumeric must be present.
 *  Pure Shift+letter = capitals (normal typing) — always rejected. */
export function isValidBinding(b: Binding): boolean {
  if (isReservedKey(b.key)) return false;
  if (b.cmd || b.alt) return true;
  // A function key types nothing, so it needs no modifier to be safe: F12 on
  // its own is go-to-definition in every IDE this app's users come from.
  if (/^F([1-9]|1[0-9]|20)$/.test(b.key)) return true;
  // Shift+punctuation (e.g. ⇧?) is a valid shortcut; Shift+letter is not.
  return b.shift && !/^[a-z0-9]$/i.test(b.key);
}

/**
 * A binding, in CodeMirror's own key notation ("Mod-Alt-b").
 *
 * The code-navigation keys live in a CodeMirror keymap rather than the window
 * handler, because they must only fire while an editor has focus, and CM
 * spells its modifiers differently from us. `cmd` becomes `Mod-`, which is
 * exactly our own Cmd/Ctrl fold.
 */
export function bindingToCmKey(b: Binding): string {
  return [b.cmd && "Mod", b.alt && "Alt", b.shift && "Shift", b.key]
    .filter(Boolean).join("-");
}

/** True on macOS. The handler folds Cmd≡Ctrl so shortcuts FIRE on every
 *  platform (Ctrl+L on Linux/Windows hits the same command as ⌘L on a Mac);
 *  this flag only changes how modifiers are LABELLED. Detected once from the
 *  user agent — synchronous, unlike Tauri's async `platform()`. */
export { IS_MAC };

/** The Cmd-or-Ctrl modifier reads as "Cmd" on macOS, "Ctrl" elsewhere; the
 *  Option-or-Alt modifier reads as "Option" on macOS, "Alt" elsewhere. */
export const CMD_LABEL = IS_MAC ? "Cmd" : "Ctrl";
export const ALT_LABEL = IS_MAC ? "Option" : "Alt";

const ARROW_GLYPH: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

/** Platform-appropriate human label for a display glyph. Modifier words track
 *  the OS convention; arrows + named keys are universal; letters / digits /
 *  punctuation render as themselves. */
export function glyphLabel(glyph: string): string {
  switch (glyph) {
    case "⌘": return CMD_LABEL;
    case "⌥": return ALT_LABEL;
    case "⌃": return "Ctrl";
    case "⇥": return "Tab";
    case "⇧": return "Shift";
    case "↑": return "Up";
    case "↓": return "Down";
    case "←": return "Left";
    case "→": return "Right";
    case "↩": return "Return";
    case "␣": return "Space";
    case ",": return "Comma";
    default: return glyph;
  }
}

/** Render a key token as a display glyph (↑, 1…9, L, [ …). */
export function keyGlyph(key: string): string {
  if (key === "1-9") return "1…9";
  if (ARROW_GLYPH[key]) return ARROW_GLYPH[key];
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  return key;
}

/** Ordered glyph chips for a binding, e.g. ["⌥","⌘","↑"] or ["⌘","1…9"].
 *  Modifier order matches the app's historic strings: ⌥, ⇧, ⌘, then key. */
export function bindingGlyphs(b: Binding, isMac: boolean = IS_MAC): string[] {
  const out: string[] = [];
  if (isMac) {
    if (b.alt) out.push("⌥");
    if (b.shift) out.push("⇧");
    if (b.cmd) out.push("⌘");
  } else {
    // The same Ctrl, Alt, Shift order `bindingText` prints off macOS. The
    // key chips are these glyphs drawn one per chip, and in the macOS order
    // the Shortcuts page read "Shift Ctrl A" and "Alt Ctrl Up" on Linux.
    if (b.cmd) out.push("⌘");
    if (b.alt) out.push("⌥");
    if (b.shift) out.push("⇧");
  }
  out.push(keyGlyph(b.key));
  return out;
}

/** A binding as one string, for tooltips and hints: the glyph run on macOS
 *  (`⌥⌘P`), the Windows / Linux convention elsewhere (`Ctrl+Alt+P`), where
 *  ⌘ and ⌥ are keys nobody has. */
export function bindingText(b: Binding, isMac: boolean = IS_MAC): string {
  if (isMac) return bindingGlyphs(b, true).join("");
  // Windows / Linux order: Ctrl, Alt, Shift, then the key (Microsoft's
  // style guide, and what VS Code and Windows Terminal print). The glyph
  // order above is the macOS one (⌥⇧⌘), which read "Shift+Ctrl+P".
  const parts: string[] = [];
  if (b.cmd) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  parts.push(glyphLabel(keyGlyph(b.key)));
  return parts.join("+");
}

/** One chip's label: the glyph on macOS, the key's name elsewhere. */
export function displayGlyph(glyph: string): string {
  return IS_MAC ? glyph : glyphLabel(glyph);
}

/** Stable signature for conflict detection (two ids sharing one = a clash). */
export function bindingSignature(b: Binding): string {
  return `${b.cmd ? "C" : ""}${b.shift ? "S" : ""}${b.alt ? "A" : ""}:${b.key}`;
}

export function bindingsEqual(a: Binding | undefined, b: Binding | undefined): boolean {
  if (!a || !b) return false;
  return a.cmd === b.cmd && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}
