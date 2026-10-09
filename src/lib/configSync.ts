// Config sync, the window's half (docs/ideas/config-sync.md). Phase 1 is
// manual sync plus the launch pull. A focus pull (no push) is the first
// piece of phase 2.
//
// Rust (src-tauri/src/config_sync.rs) owns git and the files. This module
// owns localStorage, which Rust cannot read: every sync command takes a
// snapshot of the registry's "sync" keys from here, and hands back the keys a
// pull changed for this module to write.
//
// Every profile window is a webview on the same origin, so they share one
// localStorage. That is what lets one window snapshot (and write) every bound
// profile's scoped keys, not only its own: a profile's keys are its
// namespace (`profileScope.ts`) plus the bare key. The other windows are told
// to reload their stores from storage, which publishes only what moved.
//
// The performance rule this keeps (docs/performance.md, bear trap 8): a pull
// that changed nothing writes nothing. A key whose stored value already
// matches is not written, and the store reloads compare before they `set`.

import { emit, listen } from "@tauri-apps/api/event";
import { PREF_KEYS } from "@/lib/prefsRegistry";
import { PROFILE_NS } from "@/lib/profileScope";
import { i18n } from "@/lib/i18n";
import { syncFocusPull, syncLaunchPull, syncNow, syncStatus } from "@/lib/ipc";
import type { SyncChange, SyncPrefsChanges, SyncPrefsSnapshot, SyncRunResult, SyncStatus } from "@/lib/types";
import { reloadPrefsFromStorage, usePrefs } from "@/store/prefs";
import { usePromptLibrary } from "@/store/prompts";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";

const SYNC_KEYS = PREF_KEYS.filter(k => k.class === "sync" && !k.family && !k.legacy);
/** Sync keys every window shares (not `scoped()`): machine-wide. */
export const SHARED_SYNC_KEYS: readonly string[] = SYNC_KEYS.filter(k => !k.scoped).map(k => k.key);
/** Sync keys a profile owns, stored under its namespace. */
export const SCOPED_SYNC_KEYS: readonly string[] = SYNC_KEYS.filter(k => k.scoped).map(k => k.key);

/** Rust's event after a run that changed anything. */
export const SYNC_CHANGED_EVENT = "termic://sync-changed";
/** This module's event once a window has written pulled prefs to storage. */
export const SYNC_PREFS_WRITTEN_EVENT = "termic://sync-prefs-written";

/** A profile's localStorage namespace, as Rust's `profile_ns` spells it. */
const isNamespace = (ns: string) => ns === "" || /^profile-[a-z0-9-]+:$/.test(ns);

function read(storage: Storage, key: string): string | null {
  try { return storage.getItem(key); } catch { return null; }
}

/** The sync keys as stored now: the shared ones, and each namespace's scoped
 *  ones. A key that is absent (reads as its default) is absent here too. */
export function snapshotSyncPrefs(namespaces: readonly string[], storage: Storage = localStorage): SyncPrefsSnapshot {
  const shared: Record<string, string> = {};
  for (const k of SHARED_SYNC_KEYS) {
    const v = read(storage, k);
    if (v !== null) shared[k] = v;
  }
  const scoped: Record<string, Record<string, string>> = {};
  for (const ns of new Set(namespaces)) {
    if (!isNamespace(ns)) continue;
    const m: Record<string, string> = {};
    for (const k of SCOPED_SYNC_KEYS) {
      const v = read(storage, ns + k);
      if (v !== null) m[k] = v;
    }
    scoped[ns] = m;
  }
  return { shared, scoped };
}

export interface WrittenPrefs { shared: string[]; scoped: Record<string, string[]> }

/** Write what a pull changed. Only registry "sync" keys are accepted (a repo
 *  file could name any key, and a local one like `terminalRenderer` must
 *  never arrive from another machine), and only a key whose stored value
 *  differs is written. Returns the keys actually written. */
export function writeSyncPrefs(changes: SyncPrefsChanges, storage: Storage = localStorage): WrittenPrefs {
  const out: WrittenPrefs = { shared: [], scoped: {} };
  const put = (full: string, value: string | null): boolean => {
    if (read(storage, full) === value) return false;
    try {
      if (value === null) storage.removeItem(full);
      else storage.setItem(full, value);
      return true;
    } catch { return false; }
  };
  for (const c of changes.shared) {
    if (SHARED_SYNC_KEYS.includes(c.key) && put(c.key, c.value)) out.shared.push(c.key);
  }
  for (const [ns, cs] of Object.entries(changes.scoped)) {
    if (!isNamespace(ns)) continue;
    for (const c of cs) {
      if (SCOPED_SYNC_KEYS.includes(c.key) && put(ns + c.key, c.value)) (out.scoped[ns] ??= []).push(c.key);
    }
  }
  return out;
}

const wroteAny = (w: WrittenPrefs) => w.shared.length > 0 || Object.values(w.scoped).some(v => v.length > 0);

/** Bring this window's stores up to what storage holds. Each reload compares
 *  before it publishes, so this is free when nothing moved. Every sync key
 *  lives in one of these three stores, which is why nothing a pull brings
 *  waits for a relaunch. */
export function reloadSyncedStores(): boolean {
  const prefs = reloadPrefsFromStorage();
  const prompts = usePromptLibrary.getState().reloadFromStorage();
  const colors = useApp.getState().reloadGroupColors();
  return prefs.length > 0 || prompts || colors;
}

/** Settings a pull can change that only take effect at the next launch. */
export const NEXT_LAUNCH_SETTINGS: readonly string[] = ["auto_install_hooks"];

/** Write a run's prefs, reload, tell the other windows, surface notices. */
export async function applyRunResult(res: SyncRunResult): Promise<void> {
  if (wroteAny(writeSyncPrefs(res.prefs))) {
    reloadSyncedStores();
    void emit(SYNC_PREFS_WRITTEN_EVENT, {}).catch(() => {});
  }
  await surfaceNotices();
}

/** The snapshot every run command takes, for every bound profile. */
export function snapshotFor(st: Pick<SyncStatus, "bound">): SyncPrefsSnapshot {
  return snapshotSyncPrefs([PROFILE_NS, ...st.bound.map(b => b.ns)]);
}

/** "Sync now", the launch pull, or a pull when the window regains focus.
 *  `null` when sync is not set up here. A focus pull Rust skipped as not due
 *  writes nothing and announces nothing. */
export async function runSync(kind: "now" | "launch" | "focus"): Promise<SyncRunResult | null> {
  const st = await syncStatus();
  if (!st.connected || st.bound.length === 0) return null;
  const snap = snapshotFor(st);
  const res = kind === "now" ? await syncNow(snap)
    : kind === "focus" ? await syncFocusPull(snap)
    : await syncLaunchPull(snap);
  // A skipped focus pull did not run. Applying it would re-read status for
  // notices that did not change.
  if (!res.skipped) await applyRunResult(res);
  if (res.scratchpad_changed) useUI.getState().reloadFileTree();
  // Background runs only. "Sync now" already draws the failure and the
  // conflict list on the page the user is looking at.
  // "Sync now" is the page the user is looking at, so it remembers the set
  // without a toast. An empty set forgets it: the same files can toast again
  // the next time they conflict.
  surfaceConflicts(res.conflicts, kind !== "now");
  if (kind !== "now") {
    if (res.error) surfaceSyncFailure(res.error);
    else if (res.ok) noteSyncRunSucceeded();
  }
  return res;
}

/** The rising edge of window focus: one pull, if Rust says it is due.
 *  The promise settles when that pull does; a focus that is not a rising
 *  edge settles immediately. Failures are swallowed: a focus handler must
 *  not surface an unhandled rejection. */
export function onConfigSyncFocus(focused: boolean, wasFocused: boolean): Promise<void> {
  if (!focused || wasFocused) return Promise.resolve();
  return runSync("focus").then(() => {}).catch(() => {});
}

// ── safety notices ──

/** Field and pref names, for people. Literal keys so the used-keys test sees
 *  them. `t` is i18next's, with namespace-qualified keys. */
export function fieldLabel(field: string, t: (k: string) => string): string {
  switch (field) {
    case "default_yolo": return t("settings:sync.fields.projectYolo");
    case "default_sandbox": return t("settings:sync.fields.projectSandbox");
    case "default_sandbox_mode": return t("settings:sync.fields.projectSandboxMode");
    case "default_docker": return t("settings:sync.fields.projectDocker");
    case "defaultYolo": return t("settings:sync.fields.appYolo");
    case "globalDefaultSandboxKind": return t("settings:sync.fields.appSandbox");
    case "sandboxBypassPermissions": return t("settings:sync.fields.appBypass");
    case "sandboxAllowScope": return t("settings:sync.fields.appAllowScope");
    default: return field;
  }
}

export function valueLabel(v: unknown, t: (k: string) => string): string {
  if (v === null || v === undefined || v === "") return t("settings:sync.values.default");
  if (v === true || v === "1") return t("settings:sync.values.on");
  if (v === false || v === "0") return t("settings:sync.values.off");
  return String(v);
}

/** One safety change as a line: "All projects: Start new tasks in YOLO changed
 *  from Off to On". The verb is in the line on purpose: "YOLO, Off to On" read
 *  as if the setting were called "Off to On". */
export function describeSafety(c: SyncChange, t: (k: string, o?: Record<string, unknown>) => string): string {
  const field = c.kind === "pref" ? fieldLabel(c.target, t) : fieldLabel(c.field ?? "", t);
  const scope = c.kind === "pref" ? t("settings:sync.appWide") : c.target;
  return t("settings:sync.safetyLine", { scope, field, from: valueLabel(c.from, t), to: valueLabel(c.to, t) });
}

/** Announced and kept until dismissed: mirrors `is_notice` in config_sync.rs. */
export function isNotice(c: SyncChange): boolean {
  return c.safety || (c.kind === "agent" && c.action === "remove");
}

/** A notice as a line, for the panel and the toast. An agent removal is
 *  applied, not asked (it deletes no files, unlike removing a project), so
 *  the line says what it costs here. */
export function describeNotice(c: SyncChange, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (c.kind === "agent" && c.action === "remove") return t("settings:sync.agentRemoved", { name: c.target });
  return describeSafety(c, t);
}

let lastToasted = "";

/** Toast the notices a pull made for this window's profile (safety-default
 *  changes, agents removed elsewhere), once per set. They stay listed in
 *  Settings > Sync until dismissed. */
export async function surfaceNotices(): Promise<void> {
  let st: SyncStatus;
  try { st = await syncStatus(); } catch { return; }
  const notices = st.notices.filter(isNotice);
  const sig = JSON.stringify(notices);
  if (!notices.length || sig === lastToasted) return;
  lastToasted = sig;
  const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
  // Each line ends its own sentence: an agent removal is two of them.
  const end = (s: string) => (/[.。]$/.test(s) ? s : `${s}${/[\u4e00-\u9fff]/.test(s) ? "。" : "."}`);
  const lines = notices.slice(0, 3).map(n => end(describeNotice(n, t))).join(" ");
  const more = notices.length > 3 ? ` ${end(t("settings:sync.andMore", { count: notices.length - 3 }))}` : "";
  useUI.getState().pushToast(t("settings:sync.safetyToast", { lines: lines + more }), "warning", {
    sticky: true,
    action: { label: t("settings:sync.review"), onClick: () => useApp.getState().openSettings("sync") },
  });
}

// ── background failures ──
//
// A launch pull and a focus pull both happen while the user is not looking at
// Settings > Sync. A conflict or a sign-in failure has to show up anyway. An
// offline machine stays quiet: the same fetch will fail again, and a toast
// per focus is noise. The once-key is the error text, cleared when a run
// succeeds, so a failure that comes back after a good sync is reported again.

const AUTH_MARKERS = [
  "authentication failed",
  "permission denied",
  "publickey",
  "could not read username",
  "terminal prompts disabled",
  "invalid username or password",
  "access rights",
  "gh007",
  "password authentication was removed",
  "returned error: 401",
  "returned error: 403",
  "http basic: access denied",
];

const OFFLINE_MARKERS = [
  "could not resolve host",
  "could not resolve hostname",
  "name or service not known",
  "nodename nor servname",
  "temporary failure in name resolution",
  "network is unreachable",
  "no route to host",
  "operation timed out",
  "connection timed out",
  "timed out",
  "connection refused",
  "couldn't connect",
  "could not connect",
  "failed to connect",
  "connection reset",
  "early eof",
  "recv failure",
  "the remote end hung up unexpectedly",
];

/** How a background sync failure should be told, if at all. Auth is checked
 *  first: git wraps it in the same "could not read from remote" line it uses
 *  for a network failure. */
export function syncFailureKind(error: string): "offline" | "auth" | "other" {
  const s = error.toLowerCase();
  if (AUTH_MARKERS.some(m => s.includes(m))) return "auth";
  if (OFFLINE_MARKERS.some(m => s.includes(m))) return "offline";
  return "other";
}

function failureLine(error: string): string {
  const line = error.split("\n").map(s => s.trim()).find(Boolean) ?? error.trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

let lastFailureToasted = "";
let lastConflictToast = "";

const reviewAction = (t: (k: string) => string) => ({
  label: t("settings:sync.review"),
  onClick: () => useApp.getState().openSettings("sync"),
});

/** Toast a conflict set once while it is still waiting. An empty set means it
 *  was settled (a resolve, a sync, or a disconnect), and the same paths can
 *  toast again if they conflict later. `toast` is false when the user is
 *  already on Settings > Sync: the list is the announcement, but the
 *  signature still has to move. */
export function surfaceConflicts(paths: readonly string[], toast = true): void {
  if (!paths.length) {
    lastConflictToast = "";
    return;
  }
  const sig = [...paths].sort().join("\n");
  if (sig === lastConflictToast) return;
  lastConflictToast = sig;
  if (!toast) return;
  const t = i18n.t.bind(i18n) as (k: string) => string;
  useUI.getState().pushToast(t("settings:sync.conflictToast"), "warning", {
    sticky: true,
    action: reviewAction(t),
  });
}

/** Toast a background failure once per distinct text. Offline says nothing. */
export function surfaceSyncFailure(error: string): void {
  const kind = syncFailureKind(error);
  if (kind === "offline") return;
  if (error === lastFailureToasted) return;
  lastFailureToasted = error;
  const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
  const msg = kind === "auth" ? t("settings:sync.authToast") : t("settings:sync.failureToast", { error: failureLine(error) });
  useUI.getState().pushToast(msg, "error", { sticky: true, action: reviewAction(t) });
}

function noteSyncRunSucceeded(): void {
  lastFailureToasted = "";
}

// ── boot ──

let started = false;

/** Once per window, after first paint: listen for runs other windows make,
 *  run the launch pull (Rust lets only the first window's through), and pull
 *  again when this window regains focus if the last pull is old enough. */
export function initConfigSync(): void {
  if (started) return;
  started = true;
  void listen<{ profiles: string[]; themes: boolean; scratchpad?: boolean }>(SYNC_CHANGED_EVENT, ev => {
    if (ev.payload.profiles.includes(PROFILE_NS)) void useApp.getState().loadAll();
    if (ev.payload.themes) void usePrefs.getState().loadCustomThemes();
    if (ev.payload.scratchpad) useUI.getState().reloadFileTree();
    void surfaceNotices();
  }).catch(() => {});
  void listen(SYNC_PREFS_WRITTEN_EVENT, () => { reloadSyncedStores(); }).catch(() => {});
  useUI.subscribe((s, prev) => onConfigSyncFocus(s.windowFocused, prev.windowFocused));
  void runSync("launch").catch(() => {});
}
