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
    hint: "In the editor. Lands on the source, not a stub; ⌘-click does the same.",
    defaultBinding: B("F12") },
  { id: "find-usages", group: "Code navigation", label: "Find usages",
    hint: "In the editor. ⌘-clicking a definition asks the same question.",
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
    hint: "An untitled buffer in this task. It survives a relaunch; ⌘S saves it into the project.",
    defaultBinding: B("n", { cmd: true, alt: true }) },
  { id: "close-tab", group: "Tabs", label: "Close active tab",
    defaultBinding: B("w", { cmd: true }) },

  // Terminal
  { id: "focus-terminal", group: "Terminal", label: "Focus main agent",
    hint: "Jump focus to the main pane (its agent terminal or the open editor) from anywhere",
    defaultBinding: B("l", { cmd: true }) },
  { id: "clear-terminal", group: "Terminal", label: "Clear focused terminal",
    hint: "Clears the focused terminal's scrollback, the standard ⌘K every terminal uses.",
    defaultBinding: B("k", { cmd: true }) },
  { id: "split-pane-right", group: "Terminal", label: "Split pane right",
    hint: "Open a new pane to the right of the focused pane (vertical divider).",
    defaultBinding: B("d", { cmd: true }) },
  { id: "split-pane-below", group: "Terminal", label: "Split pane below",
    hint: "Open a new pane below the focused pane (horizontal divider). Also: ⇧⌘D by default.",
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
    hint: "Search every command and action (the ⇧⌘P convention from VS Code / Sublime)",
    defaultBinding: B("p", { cmd: true, shift: true }) },
  { id: "new-task-quick", group: "General", label: "New task…",
    hint: "Search a project and start a new task", defaultBinding: B("n", { cmd: true }) },
  { id: "open-settings", group: "General", label: "Open settings",
    defaultBinding: B(",", { cmd: true }) },
{ id: "file-finder", group: "General", label: "Open file finder",
    defaultBinding: B("p", { cmd: true }) },
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

/** Normalize a live KeyboardEvent's key to the same token space as `Binding.key`. */
export function eventKeyToken(e: KeyboardEvent): string {
  const k = e.key;
  if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase();
  return k; // ArrowUp / "[" / "]" / "," / digits …
}

/** True when the event's modifiers + key satisfy the binding. The "1-9"
 *  sentinel matches any digit 1-9 with the binding's modifiers. */
export function bindingMatches(e: KeyboardEvent, b: Binding | undefined): boolean {
  if (!b) return false;
  // LINUX/WINDOWS: folding Ctrl into `cmd` is safe on macOS (the shell uses
  // the physically-separate Ctrl key, the app uses Cmd) but hijacks readline
  // off macOS — Ctrl+W (close-tab), Ctrl+K (clear-terminal), Ctrl+T (new-tab),
  // Ctrl+P (file-finder) are all emacs/readline editing keys. `focus-terminal`
  // dodges this via its isTyping guard; the others don't. Before shipping a
  // real Linux/Windows build, gate this fold so Ctrl is only the app modifier
  // when focus is NOT inside a terminal (or require Meta specifically on those
  // platforms). See the matching note in useShortcuts.ts.
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd !== b.cmd || e.shiftKey !== b.shift || e.altKey !== b.alt) return false;
  if (b.key === "1-9") return /^[1-9]$/.test(e.key);
  return eventKeyToken(e) === b.key;
}

/** Build a Binding from a recorded keydown. Returns null for a bare modifier
 *  press (no real key yet). `digitMode` collapses a recorded digit into the
 *  "1-9" range sentinel (used by the jump-to-tab row). */
export function bindingFromEvent(e: KeyboardEvent, digitMode = false): Binding | null {
  const k = e.key;
  if (k === "Meta" || k === "Control" || k === "Shift" || k === "Alt" || k === "CapsLock") {
    return null;
  }
  let key: string;
  if (/^[a-zA-Z]$/.test(k)) key = k.toLowerCase();
  else if (/^[0-9]$/.test(k)) key = digitMode ? "1-9" : k;
  else key = k;
  return { cmd: e.metaKey || e.ctrlKey, shift: e.shiftKey, alt: e.altKey, key };
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
export const IS_MAC: boolean = (() => {
  if (typeof navigator === "undefined") return true;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || "");
})();

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
export function bindingGlyphs(b: Binding): string[] {
  const out: string[] = [];
  if (b.alt) out.push("⌥");
  if (b.shift) out.push("⇧");
  if (b.cmd) out.push("⌘");
  out.push(keyGlyph(b.key));
  return out;
}

/** Stable signature for conflict detection (two ids sharing one = a clash). */
export function bindingSignature(b: Binding): string {
  return `${b.cmd ? "C" : ""}${b.shift ? "S" : ""}${b.alt ? "A" : ""}:${b.key}`;
}

export function bindingsEqual(a: Binding | undefined, b: Binding | undefined): boolean {
  if (!a || !b) return false;
  return a.cmd === b.cmd && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}
