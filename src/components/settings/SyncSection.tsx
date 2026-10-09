// Settings -> Sync (docs/ideas/config-sync.md, phase 1): this profile's setup
// synced through a private git repo the user owns.
//
// Loaded lazily from Settings.tsx, so the prefs registry and the sync module
// stay off the app-start path.
//
// The page has three states, in order: no repo on this machine (a URL and
// Connect), a repo but this profile not bound to a folder in it (pick one, or
// a new one, and see what would change before anything applies), and bound
// (Sync now, the last result, and whatever needs an answer: conflicts,
// projects waiting for a folder, removals made on another machine).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Block, SectionTitle } from "./Controls";
import {
  projectRemove, syncBind, syncConnect, syncDisconnect, syncRestoreFolder, syncDismissNotices, syncKeep, syncLocate,
  syncPreview, syncResolve, syncSkip, syncStatus,
} from "@/lib/ipc";
import {
  NEXT_LAUNCH_SETTINGS, SYNC_CHANGED_EVENT, applyRunResult, describeNotice, describeSafety, isNotice, runSync, snapshotFor, surfaceConflicts,
} from "@/lib/configSync";
import type { SyncChange, SyncFolder, SyncRunResult, SyncStatus } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";

type Busy = null | "connect" | "preview" | "apply" | "sync" | "resolve" | "disconnect";

// The fixed start of `check_repo_url`'s refusal (BAD_URL in config_sync.rs,
// which pins this copy). Rust decides; this only picks the language. Every
// other backend error stays raw (docs/i18n.md).
const BAD_URL = "Unsupported repo URL.";

export default function SyncSection() {
  const { t } = useTranslation("settings");
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState<string | null>(null);
  // Folders in the repo, once connected and this profile is not bound yet.
  const [folders, setFolders] = useState<SyncFolder[] | null>(null);
  // The picked folder: a sync id, or "" for a new one.
  const [pick, setPick] = useState<string>("");
  const [preview, setPreview] = useState<SyncChange[] | null>(null);
  const [result, setResult] = useState<SyncRunResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await syncStatus();
      setSt(next);
      return next;
    } catch (e) {
      setErr(String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    let un: (() => void) | undefined;
    void listen(SYNC_CHANGED_EVENT, () => { void refresh(); }).then(f => { un = f; }).catch(() => {});
    return () => un?.();
  }, [refresh]);

  // Connected, not bound: list the repo's folders so the user can pick one.
  useEffect(() => {
    if (!st?.connected || st.sync_id || folders || !st.repo_url) return;
    let cancelled = false;
    void syncConnect(st.repo_url).then(info => {
      if (cancelled) return;
      setFolders(info.folders);
      // The folder with this profile's name if there is one (the reason it
      // is waiting here at all), else a new folder. Never "the first one in
      // the list": every other folder becomes a profile of its own on the
      // next sync, so defaulting to one would merge two profiles on a click.
      setPick(st.suggested_folder ?? "");
    }).catch(e => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [st, folders]);

  async function act<T>(kind: Busy, f: () => Promise<T>): Promise<T | undefined> {
    setBusy(kind);
    setErr(null);
    try { return await f(); } catch (e) {
      setErr(String(e).startsWith(BAD_URL) ? t("sync.badUrl") : String(e));
      return undefined;
    } finally { setBusy(null); }
  }

  async function finish(res: SyncRunResult | undefined) {
    if (!res) return null;
    setResult(res);
    await applyRunResult(res);
    return await refresh();
  }

  const connect = () => act("connect", async () => {
    const info = await syncConnect(url);
    if (info.empty) {
      // An empty repo has nothing to apply here: this machine's setup is
      // what gets pushed.
      const cur = await syncStatus();
      await finish(await syncBind(null, snapshotFor(cur)));
      return;
    }
    setFolders(info.folders);
    const cur = await syncStatus();
    // On a machine that is not syncing yet there is nothing to compare names
    // with, so the first folder stays the default, as before.
    setPick(cur.suggested_folder ?? info.folders[0]?.sync_id ?? "");
    setSt(cur);
  });

  const showPreview = () => act("preview", async () => {
    const cur = await syncStatus();
    setPreview(await syncPreview(pick || null, snapshotFor(cur)));
  });

  const apply = () => act("apply", async () => {
    const cur = await syncStatus();
    await finish(await syncBind(pick || null, snapshotFor(cur)));
    setPreview(null);
    setFolders(null);
  });

  const syncNowClick = () => act("sync", async () => {
    const res = await runSync("now");
    if (res) { setResult(res); await refresh(); }
  });

  const resolve = (path: string, choice: "local" | "remote") => act("resolve", async () => {
    const cur = await syncStatus();
    const res = await syncResolve(path, choice, snapshotFor(cur));
    // A partial choice leaves the same files waiting. A finished one clears
    // them. Either way the background toast has to learn which, or the same
    // paths conflicting again later in this session stay silent.
    const after = res.skipped ? await refresh() : await finish(res);
    surfaceConflicts((after?.conflicts ?? []).map(c => c.path), false);
  });

  const restore = (folder: string) => act("sync", async () => {
    const cur = await syncStatus();
    await finish(await syncRestoreFolder(folder, snapshotFor(cur)));
  });

  const disconnect = () => act("disconnect", async () => {
    await syncDisconnect();
    setFolders(null);
    setPreview(null);
    setResult(null);
    const after = await refresh();
    surfaceConflicts((after?.conflicts ?? []).map(c => c.path), false);
  });

  if (!st) return <SectionTitle title={t("sync.title")} badge={t("shared.experimental")} />;
  const bound = !!st.sync_id;

  return (
    <div className="flex flex-col gap-6" data-testid="sync-section">
      <div>
        <SectionTitle title={t("sync.title")} badge={t("shared.experimental")} />
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">{t("sync.desc1")}</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-fg-faint)]">{t("sync.desc2")}</p>
      </div>

      <Block first>
        {!st.connected && (
          <div className="flex flex-col gap-2">
            <label className="text-[13px] font-medium" htmlFor="sync-url">{t("sync.urlLabel")}</label>
            <div className="flex items-center gap-2">
              <Input
                id="sync-url"
                data-testid="sync-url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && url.trim()) void connect(); }}
                placeholder={t("sync.urlPlaceholder")}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                className="mono flex-1"
              />
              <Button variant="primary" onClick={() => void connect()} disabled={!url.trim() || busy !== null} data-testid="sync-connect">
                {busy === "connect" ? t("sync.connecting") : t("sync.connect")}
              </Button>
            </div>
            <p className="text-[12px] text-[var(--color-fg-dim)]">{t("sync.urlHint")}</p>
          </div>
        )}

        {st.connected && (
          <div className="flex flex-col gap-3">
            {/* One grid, so the two values start on the same line whatever
                each label measures in the current language. */}
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-1.5 text-[13px]">
              <span className="text-[var(--color-fg-dim)]">{t("sync.repo")}</span>
              <code className="mono break-all text-[12.5px]" data-testid="sync-repo-url">{st.repo_url}</code>
              {bound && (
                <>
                  <span className="text-[var(--color-fg-dim)]">{t("sync.folder")}</span>
                  <span data-testid="sync-folder-name">
                    {st.folder_name ?? st.sync_id} <code className="mono text-[11.5px] text-[var(--color-fg-faint)]">profiles/{st.sync_id}</code>
                  </span>
                </>
              )}
            </div>
            {bound && (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={() => void syncNowClick()} disabled={busy !== null} data-testid="sync-now">
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy === "sync" && "animate-spin")} />
                  {busy === "sync" ? t("sync.syncing") : t("sync.syncNow")}
                </Button>
                <span className="text-[12.5px] text-[var(--color-fg-dim)]" data-testid="sync-last">
                  {st.last_sync_at
                    ? t("sync.lastSync", { when: new Date(st.last_sync_at).toLocaleString() })
                    : t("sync.never")}
                </span>
              </div>
            )}
            {st.last_error && (
              <p className="text-[12.5px] text-[var(--color-err)]" data-testid="sync-error">
                {t("sync.lastError", { error: st.last_error })}
              </p>
            )}
            {result && bound && <ResultLine result={result} />}
          </div>
        )}

        {err && <p className="mt-3 text-[12.5px] text-[var(--color-err)]" data-testid="sync-action-error">{err}</p>}
      </Block>

      {st.connected && !bound && (
        <Block>
          <h3 className="text-[14px] font-semibold">{t("sync.pickTitle")}</h3>
          {/* Why this profile is here at all. Every other profile links
              itself, so an unlinked one is either waiting on a name it shares
              with a folder, or was told to stop. */}
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]" data-testid="sync-pick-why"
            data-why={st.opted_out ? "opted-out" : st.suggested_folder ? "same-name" : "first"}>
            {st.opted_out ? t("sync.pickOptedOut") : st.suggested_folder ? t("sync.pickSameName") : t("sync.pickHint")}
          </p>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">{t("sync.pickAuto")}</p>
          <div className="mt-3 flex flex-col gap-1.5" role="radiogroup">
            {/* A folder another profile on this machine already follows is
                not offered: two profiles exporting into one folder would
                overwrite each other. */}
            {(folders ?? []).filter(f => !st.bound.some(b => b.sync_id === f.sync_id)).map(f => (
              <FolderOption key={f.sync_id} id={f.sync_id} label={f.name} hint={`profiles/${f.sync_id}`}
                checked={pick === f.sync_id} onPick={() => { setPick(f.sync_id); setPreview(null); }} />
            ))}
            <FolderOption id="new" label={t("sync.newFolder")} checked={pick === ""}
              onPick={() => { setPick(""); setPreview(null); }} />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={() => void showPreview()} disabled={busy !== null || folders === null} data-testid="sync-preview">
              {t("sync.preview")}
            </Button>
          </div>
          {preview && (
            <div className="mt-4 rounded-lg border border-[var(--color-border)] p-3" data-testid="sync-preview-panel">
              <div className="text-[13px] font-medium">{t("sync.previewTitle")}</div>
              <p className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">{t("sync.previewHint")}</p>
              {preview.length === 0
                ? <p className="mt-2 text-[12.5px]" data-testid="sync-preview-empty">{t("sync.previewEmpty")}</p>
                : <ChangeList changes={preview} testid="sync-preview-list" />}
              <div className="mt-3 flex items-center gap-2">
                <Button variant="primary" onClick={() => void apply()} disabled={busy !== null} data-testid="sync-apply">
                  {busy === "apply" ? t("sync.applying") : t("sync.apply")}
                </Button>
                <Button variant="ghost" onClick={() => setPreview(null)} data-testid="sync-preview-cancel">
                  {t("common:cancel")}
                </Button>
              </div>
            </div>
          )}
        </Block>
      )}

      {st.notices.length > 0 && (
        <Block>
          <div className="rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3" data-testid="sync-notices">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <AlertTriangle className="h-4 w-4 text-[var(--color-warn)]" /> {t("sync.noticesTitle")}
            </div>
            <p className="mt-1 text-[12px] text-[var(--color-fg-dim)]">{t("sync.noticesHint")}</p>
            <ul className="mt-2 flex flex-col gap-1 text-[12.5px]">
              {st.notices.map((n, i) => <li key={i}>{describeNotice(n, t)}</li>)}
            </ul>
            <Button size="sm" className="mt-2" data-testid="sync-notices-dismiss"
              onClick={() => void syncDismissNotices().then(refresh).catch(e => setErr(String(e)))}>
              {t("sync.dismiss")}
            </Button>
          </div>
        </Block>
      )}

      {st.conflicts.length > 0 && (
        <Block>
          <h3 className="text-[14px] font-semibold">{t("sync.conflictsTitle")}</h3>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">{t("sync.conflictsHint")}</p>
          <div className="mt-3 flex flex-col gap-2">
            {st.conflicts.map((c, i) => (
              <div key={c.path} className="flex flex-wrap items-center justify-between gap-2" data-testid={`sync-conflict-${i}`}>
                <div className="min-w-0">
                  <div className="text-[13px]">{c.label}</div>
                  <code className="mono text-[11.5px] text-[var(--color-fg-faint)]">{c.path}</code>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant={c.choice === "local" ? "primary" : "secondary"} disabled={busy !== null}
                    data-testid={`sync-conflict-local-${i}`} onClick={() => void resolve(c.path, "local")}>
                    {t("sync.keepLocal")}
                  </Button>
                  <Button size="sm" variant={c.choice === "remote" ? "primary" : "secondary"} disabled={busy !== null}
                    data-testid={`sync-conflict-remote-${i}`} onClick={() => void resolve(c.path, "remote")}>
                    {t("sync.takeRemote")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Block>
      )}

      {bound && st.waiting.length > 0 && (
        <Block>
          <h3 className="text-[14px] font-semibold">{t("sync.waitingTitle")}</h3>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">{t("sync.waitingHint")}</p>
          <div className="mt-3 flex flex-col gap-2">
            {st.waiting.map(w => (
              <WaitingRow key={w.id} id={w.id} name={w.name}
                where={w.non_git ? t("sync.plainFolder") : [w.remote_url, w.subdir].filter(Boolean).join("  ")}
                onLocate={() => void act(null, async () => {
                  const sel = await openDialog({ directory: true, multiple: false });
                  if (typeof sel !== "string") return;
                  await syncLocate(w.id, sel);
                  await useApp.getState().loadAll();
                  await refresh();
                })}
                onSkip={() => void act(null, async () => { await syncSkip(w.id, true); await refresh(); })}
              />
            ))}
          </div>
        </Block>
      )}

      {bound && st.skipped.length > 0 && (
        <Block>
          <h3 className="text-[14px] font-semibold">{t("sync.skippedTitle")}</h3>
          <div className="mt-2 flex flex-col gap-1.5">
            {st.skipped.map(w => (
              <div key={w.id} className="flex items-center justify-between gap-2 text-[13px]" data-testid={`sync-skipped-${w.id}`}>
                <span>{w.name}</span>
                <Button size="sm" variant="ghost" data-testid={`sync-unskip-${w.id}`}
                  onClick={() => void act(null, async () => { await syncSkip(w.id, false); await refresh(); })}>
                  {t("sync.unskip")}
                </Button>
              </div>
            ))}
          </div>
        </Block>
      )}

      {bound && st.removals.length > 0 && (
        <Block>
          <h3 className="text-[14px] font-semibold">{t("sync.removalsTitle")}</h3>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">{t("sync.removalHint")}</p>
          <div className="mt-3 flex flex-col gap-2">
            {st.removals.map(r => (
              <RemovalRow key={r.id} id={r.id} name={r.name} machine={r.machine} onDone={refresh} onError={setErr} />
            ))}
          </div>
        </Block>
      )}

      <Block>
        <h3 className="text-[14px] font-semibold">{t("sync.neverTitle")}</h3>
        <div data-testid="sync-never">
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">{t("sync.never1")}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">{t("sync.never2")}</p>
        </div>
      </Block>

      {st.connected && st.ignored.length > 0 && (
        <Block>
          <h3 className="text-[14px] font-semibold">{t("sync.ignoredTitle")}</h3>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">{t("sync.ignoredHint")}</p>
          <div className="mt-3 flex flex-col gap-2" data-testid="sync-ignored">
            {st.ignored.map(f => (
              <div key={f.sync_id} className="flex flex-wrap items-center justify-between gap-2" data-testid={`sync-ignored-${f.sync_id}`}>
                <span className="text-[13px]">
                  {f.name} <code className="mono text-[11.5px] text-[var(--color-fg-faint)]">profiles/{f.sync_id}</code>
                </span>
                <Button size="sm" onClick={() => void restore(f.sync_id)} disabled={busy !== null || !bound} data-testid={`sync-restore-${f.sync_id}`}>
                  {t("sync.ignoredRestore")}
                </Button>
              </div>
            ))}
          </div>
        </Block>
      )}

      {st.connected && (
        <Block>
          <Button size="sm" onClick={() => void disconnect()} disabled={busy !== null} data-testid="sync-disconnect">
            {t("sync.disconnect")}
          </Button>
          <p className="mt-1 text-[12px] text-[var(--color-fg-faint)]">{t("sync.disconnectHint")}</p>
        </Block>
      )}
    </div>
  );
}

function FolderOption({ id, label, hint, checked, onPick }: {
  id: string; label: string; hint?: string; checked: boolean; onPick: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-[13px]",
        checked ? "border-[var(--color-accent)]" : "border-[var(--color-border-soft)]",
      )}
      data-testid={`sync-folder-option-${id}`}
    >
      <input type="radio" name="sync-folder" checked={checked} onChange={onPick} className="accent-[var(--color-accent)]" />
      <span>{label}</span>
      {hint && <code className="mono text-[11.5px] text-[var(--color-fg-faint)]">{hint}</code>}
    </label>
  );
}

function WaitingRow({ id, name, where, onLocate, onSkip }: {
  id: string; name: string; where: string; onLocate: () => void; onSkip: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid={`sync-waiting-${id}`}>
      <div className="min-w-0">
        <div className="text-[13px]">{name}</div>
        <code className="mono text-[11.5px] text-[var(--color-fg-faint)]">{where}</code>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={onLocate} data-testid={`sync-locate-${id}`}>{t("sync.locate")}</Button>
        <Button size="sm" variant="ghost" onClick={onSkip} data-testid={`sync-skip-${id}`}>{t("sync.skip")}</Button>
      </div>
    </div>
  );
}

function RemovalRow({ id, name, machine, onDone, onError }: {
  id: string; name: string; machine: string; onDone: () => Promise<unknown>; onError: (e: string) => void;
}) {
  const { t } = useTranslation("settings");
  // Removing archives every task under the project and deletes their
  // worktrees, so it asks the way Settings > project > Remove does, with the
  // same counts.
  async function removeHere() {
    const { tasks, projects, loadAll } = useApp.getState();
    const proj = projects.find(p => p.id === id);
    if (!proj) return;
    const mine = tasks.filter(w => w.project_id === id);
    const taskCount = mine.length;
    const wtCount = mine.filter(w => !w.is_main_checkout).length;
    const parts = [taskCount === 0 ? t("repo.removeNoTasks") : t("repo.removeArchives", { count: taskCount })];
    if (wtCount > 0) parts.push(t("repo.removeWorktrees", { count: wtCount }));
    parts.push(t("repo.removeUntouched", { path: proj.root_path }));
    const ok = await useUI.getState().askConfirm({
      title: t("repo.removeTitle", { name: proj.name }),
      message: parts.join(" "),
      confirmLabel: t("repo.removeConfirm"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await projectRemove(id);
      await loadAll();
      await onDone();
    } catch (e) { onError(String(e)); }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid={`sync-removal-${id}`}>
      <span className="text-[13px]">{t("sync.removalLine", { name, machine })}</span>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="danger" onClick={() => void removeHere()} data-testid={`sync-remove-${id}`}>
          {t("sync.removeHere")}
        </Button>
        <Button size="sm" onClick={() => void syncKeep(id).then(onDone).catch(e => onError(String(e)))} data-testid={`sync-keep-${id}`}>
          {t("sync.keep")}
        </Button>
      </div>
    </div>
  );
}

function ChangeList({ changes, testid }: { changes: SyncChange[]; testid: string }) {
  const { t } = useTranslation("settings");
  // Safety changes first: they are the ones that can switch approvals off.
  const sorted = [...changes].sort((a, b) => Number(b.safety) - Number(a.safety));
  return (
    <ul className="mt-2 flex flex-col gap-1 text-[12.5px]" data-testid={testid}>
      {sorted.map((c, i) => (
        <li
          key={i}
          className={cn(c.safety && "rounded bg-[var(--color-warn)]/10 px-1.5 py-0.5 text-[var(--color-fg)]")}
          data-testid={c.safety ? "sync-change-safety" : "sync-change"}
        >
          {c.safety && <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5 text-[var(--color-warn)]" />}
          {describeChange(c, t)}
        </li>
      ))}
    </ul>
  );
}

function describeChange(c: SyncChange, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (c.safety) return describeSafety(c, t);
  switch (c.kind) {
    case "project":
      if (c.action === "add") return t("sync.change.projectAdd", { name: c.target, path: String(c.to ?? "") });
      if (c.action === "wait") return t("sync.change.projectWait", { name: c.target });
      if (c.target === "order") return t("sync.change.projectOrder");
      return t("sync.change.field", { target: c.target, field: c.field ?? "" });
    case "agent":
      if (c.action === "add") return t("sync.change.agentAdd", { name: c.target });
      if (c.action === "remove") return t("sync.change.agentRemove", { name: c.target });
      return t("sync.change.field", { target: c.target, field: c.field ?? "" });
    case "settings":
      return t("sync.change.setting", { field: c.field ?? "" });
    case "pref":
      return t("sync.change.pref", { key: c.target });
    case "theme":
      return t("sync.change.theme", { name: c.target });
    case "profile":
      if (c.action === "upload") return t("sync.change.profileUpload", { name: c.target });
      if (c.action === "update") return t("sync.change.profileUpdate", { name: c.target, to: String(c.to ?? "") });
      return t("sync.change.profileAdd", { name: c.target });
    case "scratchpad":
      return t("sync.change.scratchpad", { target: c.target });
  }
}

function ResultLine({ result }: { result: SyncRunResult }) {
  const { t } = useTranslation("settings");
  if (result.error || result.conflicts.length) return null;
  // The report names only what the sections below do not. A project waiting
  // for a folder was not applied, and "Waiting for a folder" lists it, so it
  // is one count here. A notice (a YOLO or sandbox change, an agent removed
  // elsewhere) WAS applied and is counted, but its detail lives in the
  // notices panel and the toast, so it is not a line here as well.
  const applied = result.changes.filter(c => c.action !== "wait");
  const waiting = result.changes.length - applied.length;
  const listed = applied.filter(c => !isNotice(c));
  const n = applied.length;
  const nextLaunch = result.changes.some(c => c.kind === "settings" && NEXT_LAUNCH_SETTINGS.includes(c.field ?? ""));
  return (
    <div className="text-[12.5px] text-[var(--color-fg-dim)]" data-testid="sync-result">
      <span>{result.pushed ? t("sync.resultPushed") : t("sync.resultNoPush")}</span>{" "}
      {n > 0 && <span>{n === 1 ? t("sync.resultChanges_one", { count: n }) : t("sync.resultChanges_other", { count: n })}</span>}{" "}
      {waiting > 0 && <span>{waiting === 1 ? t("sync.resultWaiting_one", { count: waiting }) : t("sync.resultWaiting_other", { count: waiting })}</span>}
      {nextLaunch && <div className="mt-1">{t("sync.nextLaunchHooks")}</div>}
      {listed.length > 0 && <ChangeList changes={listed} testid="sync-result-list" />}
    </div>
  );
}
