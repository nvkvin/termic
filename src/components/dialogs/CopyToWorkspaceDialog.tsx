// Dialog for copying/exporting a scratchpad file into the task workspace.
//
// Users can export any file from Global or Project scratchpads into the current
// task's git worktree, choosing the destination path and completing folders.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Folder } from "lucide-react";
import * as ipc from "@/lib/ipc";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

const MAX_FOLDERS = 30;

function foldersFromFiles(files: string[]): string[] {
  const dirs = new Set<string>([""]);
  for (const f of files) {
    const parts = f.split("/");
    parts.pop();
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      dirs.add(acc);
    }
  }
  return [...dirs].sort();
}

function splitPath(v: string): { dir: string; name: string } {
  const i = v.lastIndexOf("/");
  return i < 0 ? { dir: "", name: v } : { dir: v.slice(0, i), name: v.slice(i + 1) };
}

export function CopyToWorkspaceDialog() {
  const { t } = useTranslation("task");
  const req = useUI(s => s.scratchExport);
  const close = useUI(s => s.closeScratchExport);

  const [path, setPath] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!req) return;
    const leaf = req.defaultRel || req.scratchPath.split("/").pop() || "note.md";
    setPath(leaf);
    setErr(null);
    setActiveIdx(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = leaf.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : leaf.length);
    });
  }, [req]);

  useEffect(() => {
    if (!req?.taskId) return;
    let cancelled = false;
    ipc.taskListFilesForFinder(req.taskId)
      .then(list => { if (!cancelled) setFiles(list); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [req?.taskId]);

  const folders = useMemo(() => foldersFromFiles(files), [files]);
  const { dir, name } = splitPath(path);

  const matches = useMemo(() => {
    if (!dir) return folders.slice(0, MAX_FOLDERS).map(f => ({ f, m: [] as number[] }));
    const out: { f: string; m: number[]; score: number }[] = [];
    for (const f of folders) {
      if (!f) continue;
      const hit = fuzzyMatch(f, dir);
      if (hit) out.push({ f, m: hit.matches, score: hit.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, MAX_FOLDERS);
  }, [folders, dir]);

  useEffect(() => { setActiveIdx(0); }, [dir]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function useFolder(folder: string) {
    setPath(folder ? `${folder}/${name}` : name);
    inputRef.current?.focus();
  }

  async function save() {
    if (!req || busy) return;
    const rel = path.trim().replace(/^\/+/, "");
    const leaf = splitPath(rel).name;
    if (!leaf) {
      setErr(t("scratchpad.errNoName", "Enter a filename"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      let overwrite = false;
      if (await ipc.scratchPromoteTargetExists(req.taskId, rel)) {
        const ok = await useUI.getState().askConfirm({
          title: t("scratchpad.overwriteTitle", "Overwrite existing file?"),
          message: t("scratchpad.overwriteMessage", { path: rel, defaultValue: `"${rel}" already exists in the workspace. Overwrite it?` }),
          confirmLabel: t("scratchpad.overwrite", "Overwrite"),
          destructive: true,
        });
        if (ok !== true) {
          setBusy(false);
          return;
        }
        overwrite = true;
      }
      await ipc.scratchCopyToWorkspace(req.scope, req.projectId, req.scratchPath, req.taskId, rel, overwrite);
      useApp.getState().openPreviewTab(req.taskId, {
        type: "edit",
        path: rel,
        title: leaf,
        permanent: true,
      });
      useApp.getState().bumpFsRevision(req.taskId);
      useApp.getState().bumpGitRevision(req.taskId);
      useUI.getState().pushToast(t("scratchpad.toastCopied", { name: leaf, defaultValue: `Saved "${leaf}" to workspace` }), "success");
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Tab") {
      const hit = matches[activeIdx];
      if (hit && hit.f) {
        e.preventDefault();
        useFolder(hit.f);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }

  if (!req) return null;

  return (
    <AppDialog
      open
      onOpenChange={(o) => { if (!o && !busy) close(); }}
      title={t("scratchpad.saveToWorkspaceTitle", "Save to Workspace")}
      description={t("scratchpad.saveToWorkspaceDescription", "Copy this scratchpad file into the current task workspace.")}
      className="max-w-[480px]"
    >
      <div className="flex flex-col gap-3 pt-2">
        <div>
          <label className="text-[12px] font-medium text-[var(--color-fg-dim)]">
            {t("scratchpad.workspacePathLabel", "Workspace destination path")}
          </label>
          <input
            ref={inputRef}
            type="text"
            value={path}
            onChange={e => setPath(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="folder/filename.md"
            className="mt-1 h-8 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 font-mono text-[13px] text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-[11px] text-[var(--color-fg-faint)]">
            {t("scratchpad.folderHint", "Folders (press Tab to complete):")}
          </div>
          <div
            ref={listRef}
            className="max-h-40 overflow-y-auto rounded border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-1 text-[12px]"
          >
            {matches.length === 0 ? (
              <div className="px-2 py-1.5 text-[var(--color-fg-faint)]">{t("scratchpad.noFolders", "Workspace root")}</div>
            ) : (
              matches.map((item, idx) => (
                <div
                  key={item.f || "__root"}
                  data-row={idx}
                  onClick={() => useFolder(item.f)}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                    idx === activeIdx && "bg-[var(--color-hover)] text-[var(--color-fg)]"
                  )}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                  <span className="truncate font-mono">
                    {item.f ? <Highlighted text={item.f} matches={item.m} /> : <span className="italic">{t("scratchpad.workspaceRoot", "Workspace root")}</span>}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {err && (
          <div className="rounded bg-[var(--color-danger-subtle)] p-2 text-[12px] text-[var(--color-danger)]">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--color-border-soft)]">
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? t("common:saving", "Saving...") : t("scratchpad.saveToWorkspaceAction", "Save to Workspace")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
