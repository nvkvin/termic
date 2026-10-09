// Which OS the webview runs on, detected once and synchronously from the
// user agent (Tauri's `platform()` is async). Kept dependency-free so the
// wire-type module (types.ts) can read it without pulling in anything else.
//
// No navigator (unit tests under node) counts as macOS, the platform every
// existing test was written against. (Unit tests under happy-dom report
// Linux; see setSeatbeltAvailableForTests.)

const UA = typeof navigator === "undefined" ? null : navigator.userAgent || "";

export const IS_MAC: boolean = UA === null || /Mac|iPhone|iPad|iPod/.test(UA);
export const IS_WINDOWS: boolean = UA !== null && /Windows/.test(UA);
export const IS_LINUX: boolean = UA !== null && !IS_MAC && !IS_WINDOWS && /Linux|X11/.test(UA);

/** The window has no native frame and the app draws minimize / maximize /
 *  close itself (`WindowControls`). macOS is the other kind of frameless: the
 *  system still draws its traffic lights on our bar. */
export const DRAWS_WINDOW_CONTROLS: boolean = IS_WINDOWS || IS_LINUX;

/** The macOS Seatbelt sandbox exists only on macOS. Everywhere else a task
 *  offers Off and Docker, and a stored Seatbelt mode (a `.termic.yaml`
 *  committed from a Mac, a project default) reads as Off. The backend
 *  applies the same rule in `Task::effective_sandbox_mode`. */
export let SEATBELT_AVAILABLE: boolean = IS_MAC;

/** Test seam: the unit-test DOM reports Linux, so specs about Seatbelt
 *  semantics opt back in, and specs about the Windows clamp opt out. */
export function setSeatbeltAvailableForTests(v: boolean): void {
  SEATBELT_AVAILABLE = v;
}

/** Window-drag regions, macOS only.
 *
 *  On macOS the title bar is hidden (an overlay title bar with traffic
 *  lights), so the app's own bar, and a dialog's backdrop, have to move the
 *  window. Windows and Linux move theirs through `startDragging()` on the
 *  bar alone (UnifiedBar), so none of that is needed, and on Windows it
 *  would do harm: WebView2 honours `-webkit-app-region: drag` (wry
 *  enables non-client region support), which turns every covered element
 *  into window caption, and a dialog's full-screen backdrop would swallow
 *  every click in the dialog. Spread `dragRegion()` where the macOS build
 *  wants a drag surface, `noDragRegion()` where it carves one out. */
export function dragRegion(): { "data-tauri-drag-region"?: boolean; style?: Record<string, string> } {
  return IS_MAC ? { "data-tauri-drag-region": true, style: { WebkitAppRegion: "drag" } } : {};
}

export function appRegionStyle(v: "drag" | "no-drag"): Record<string, string> {
  return IS_MAC ? { WebkitAppRegion: v } : {};
}

/** The one-line install command to show for a CLI the app looks for: Homebrew
 *  on macOS (and Linux, where it is the common cross-distro answer), winget
 *  on Windows, where Homebrew does not exist. */
export function installCommand(tool: string): string {
  if (!IS_WINDOWS) return `brew install ${tool}`;
  const winget: Record<string, string> = { gh: "GitHub.cli", glab: "GLab.GLab" };
  return `winget install ${winget[tool] ?? tool}`;
}

/** "Your Mac" in copy, "this computer" elsewhere. */
export const THIS_MACHINE: string = IS_MAC ? "your Mac" : "this computer";

/** A key combination written the macOS way (`⇧⌘B`, `⌘↵`, `⌥`), for copy.
 *  Returned as is on macOS; elsewhere spelled out in the Windows / Linux
 *  order and names (`Ctrl+Shift+B`, `Ctrl+Enter`, `Alt`), because ⌘ and ⌥
 *  are keys those keyboards do not have. */
export function kbd(mac: string, isMac: boolean = IS_MAC): string {
  if (isMac) return mac;
  const mods: string[] = [];
  let rest = "";
  for (const ch of mac) {
    if (ch === "⌘" || ch === "⌃") mods.push("Ctrl");
    else if (ch === "⌥") mods.push("Alt");
    else if (ch === "⇧") mods.push("Shift");
    else if (ch === "↵") rest += "Enter";
    else rest += ch;
  }
  const order = ["Ctrl", "Alt", "Shift"];
  const sorted = order.filter(m => mods.includes(m));
  return [...sorted, ...(rest ? [rest] : [])].join("+");
}
