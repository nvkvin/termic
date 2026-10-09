// "Save Scratchpad" picker opened by ⌘S on an untitled scratchpad (GH #244, common-scratchpad).
//
// Users can choose to save the buffer into:
// 1. Project Scratchpad: scoped to the current project, shared across tasks.
// 2. Global Scratchpad: user/machine-wide, shared across all projects.
// 3. Workspace: promoted to a real file in the current task's git worktree.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { useProfiles } from "@/store/profiles";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Folder } from "lucide-react";
import * as ipc from "@/lib/ipc";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { scratchFilenameSlug } from "@/lib/scratchTitle";
import { profileScratchTargetId, scratchTargetId } from "@/lib/scratchTabs";
import { livePad } from "@/lib/scratchLive";
import type { ScratchTab } from "@/lib/types";
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

async function fetchScratchFolders(scope: "project" | "profile" | "global", projectId?: string | null): Promise<string[]> {
  const dirs = new Set<string>([""]);
  const queue = [""];
  while (queue.length > 0 && dirs.size < 50) {
    const cur = queue.shift()!;
    try {
      const entries = await ipc.scratchTreeList(scope, projectId, cur);
      for (const e of entries) {
        if (e.is_dir) {
          const sub = cur ? `${cur}/${e.name}` : e.name;
          dirs.add(sub);
          queue.push(sub);
        }
      }
    } catch {
      // directory read failure ignored for completion
    }
  }
  return [...dirs].sort();
}

function splitPath(v: string): { dir: string; name: string } {
  const i = v.lastIndexOf("/");
  return i < 0 ? { dir: "", name: v } : { dir: v.slice(0, i), name: v.slice(i + 1) };
}

export function ScratchSaveDialog() {
  const { t } = useTranslation("dialogs");
  const req = useUI(s => s.scratchSave);
  const resolve = useUI(s => s.resolveScratchSave);
  const taskId = req?.taskId ?? null;
  const task = useApp(s => (taskId ? s.tasks.find(w => w.id === taskId) : null));
  const profileSlug = useProfiles(s => s.current);
  const tab = useApp(s => {
    if (!req) return null;
    const t = (s.tabs[req.taskId] ?? []).find(x => x.id === req.tabId);
    return t?.type === "scratch" ? (t as ScratchTab) : null;
  });

  const [targetScope, setTargetScope] = useState<"project" | "profile" | "global" | "workspace">("workspace");
  const [path, setPath] = useState("");
  const [folders, setFolders] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Initialize destination based on tab scope
  useEffect(() => {
    if (!req || !tab) return;
    if (tab.scope === "project" && task?.project_id) {
      setTargetScope("project");
    } else if (tab.scope === "profile") {
      setTargetScope("profile");
    } else if (tab.scope === "global") {
      setTargetScope("global");
    } else {
      setTargetScope("workspace");
    }
  }, [req, tab?.id, tab?.scope, task?.project_id]);

  // Seed the filename from derived title
  useEffect(() => {
    if (!req || !tab) return;
    const seed = `${scratchFilenameSlug(tab.title)}.md`;
    setPath(seed);
    setErr(null);
    setActiveIdx(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, seed.lastIndexOf("."));
    });
  }, [req?.taskId, req?.tabId]);

  // Fetch folders for the selected destination
  useEffect(() => {
    let cancelled = false;
    if (targetScope === "workspace") {
      if (!taskId) return;
      ipc.taskListFilesForFinder(taskId)
        .then(list => {
          if (!cancelled) setFolders(foldersFromFiles(list));
        })
        .catch(() => {
          if (!cancelled) setFolders([""]);
        });
    } else if (targetScope === "project") {
      fetchScratchFolders("project", task?.project_id)
        .then(list => {
          if (!cancelled) setFolders(list);
        })
        .catch(() => {
          if (!cancelled) setFolders([""]);
        });
    } else if (targetScope === "profile") {
      fetchScratchFolders("profile", profileSlug)
        .then(list => {
          if (!cancelled) setFolders(list);
        })
        .catch(() => {
          if (!cancelled) setFolders([""]);
        });
    } else {
      fetchScratchFolders("global", null)
        .then(list => {
          if (!cancelled) setFolders(list);
        })
        .catch(() => {
          if (!cancelled) setFolders([""]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [targetScope, taskId, task?.project_id, profileSlug]);

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

  useEffect(() => {
    setActiveIdx(0);
  }, [dir]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function useFolder(folder: string) {
    setPath(folder ? `${folder}/${name}` : name);
    inputRef.current?.focus();
  }

  async function save() {
    if (!taskId || !tab || busy) return;
    const rel = path.trim().replace(/^\/+/, "");
    const leaf = splitPath(rel).name;
    if (!leaf) {
      setErr(t("scratchSave.errNoName", "Enter a filename"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const targetId = scratchTargetId(tab, taskId);
      const content = livePad(targetId, tab.scratchId)?.text() ?? (await ipc.scratchRead(targetId, tab.scratchId));

      if (targetScope === "project") {
        if (!task?.project_id) {
          setErr(t("scratchSave.errNoProject", "No associated project"));
          setBusy(false);
          return;
        }
        let exists = false;
        try {
          await ipc.scratchFileRead("project", task.project_id, rel);
          exists = true;
        } catch {
          // not found
        }
        if (exists) {
          const ok = await useUI.getState().askConfirm({
            title: t("scratchSave.overwriteTitle", "Overwrite existing file?"),
            message: t("scratchSave.overwriteMessage", { path: rel }),
            confirmLabel: t("scratchSave.overwrite", "Overwrite"),
            destructive: true,
          });
          if (ok !== true) {
            setBusy(false);
            return;
          }
        }
        await ipc.scratchFileWrite("project", task.project_id, rel, content);
        await ipc.scratchDelete(targetId, tab.scratchId);
        useApp.getState().patchTab(taskId, tab.id, {
          scope: "project",
          projectId: task.project_id,
          targetId: `project_${task.project_id}`,
          path: rel,
          title: leaf,
          dirty: false,
        });
        useUI.getState().reloadFileTree();
        useUI.getState().pushToast(t("scratchSave.toastSavedProject", { name: leaf, defaultValue: `Saved "${leaf}" to Project Scratchpad` }), "success");
        resolve(true);
      } else if (targetScope === "profile") {
        let exists = false;
        try {
          await ipc.scratchFileRead("profile", profileSlug, rel);
          exists = true;
        } catch {
          // not found
        }
        if (exists) {
          const ok = await useUI.getState().askConfirm({
            title: t("scratchSave.overwriteTitle", "Overwrite existing file?"),
            message: t("scratchSave.overwriteMessage", { path: rel }),
            confirmLabel: t("scratchSave.overwrite", "Overwrite"),
            destructive: true,
          });
          if (ok !== true) {
            setBusy(false);
            return;
          }
        }
        await ipc.scratchFileWrite("profile", profileSlug, rel, content);
        await ipc.scratchDelete(targetId, tab.scratchId);
        useApp.getState().patchTab(taskId, tab.id, {
          scope: "profile",
          projectId: profileSlug ?? undefined,
          targetId: profileScratchTargetId(),
          path: rel,
          title: leaf,
          dirty: false,
        });
        useUI.getState().reloadFileTree();
        useUI.getState().pushToast(t("scratchSave.toastSavedProfile", { name: leaf, defaultValue: `Saved "${leaf}" to Profile Scratchpad` }), "success");
        resolve(true);
      } else if (targetScope === "global") {
        let exists = false;
        try {
          await ipc.scratchFileRead("global", null, rel);
          exists = true;
        } catch {
          // not found
        }
        if (exists) {
          const ok = await useUI.getState().askConfirm({
            title: t("scratchSave.overwriteTitle", "Overwrite existing file?"),
            message: t("scratchSave.overwriteMessage", { path: rel }),
            confirmLabel: t("scratchSave.overwrite", "Overwrite"),
            destructive: true,
          });
          if (ok !== true) {
            setBusy(false);
            return;
          }
        }
        await ipc.scratchFileWrite("global", null, rel, content);
        await ipc.scratchDelete(targetId, tab.scratchId);
        useApp.getState().patchTab(taskId, tab.id, {
          scope: "global",
          targetId: "global",
          path: rel,
          title: leaf,
          dirty: false,
        });
        useUI.getState().reloadFileTree();
        useUI.getState().pushToast(t("scratchSave.toastSavedGlobal", { name: leaf, defaultValue: `Saved "${leaf}" to Global Scratchpad` }), "success");
        resolve(true);
      } else {
        let overwrite = false;
        if (await ipc.scratchPromoteTargetExists(taskId, rel)) {
          const ok = await useUI.getState().askConfirm({
            title: t("scratchSave.overwriteTitle", "Overwrite existing file?"),
            message: t("scratchSave.overwriteMessage", { path: rel }),
            confirmLabel: t("scratchSave.overwrite", "Overwrite"),
            destructive: true,
          });
          if (ok !== true) {
            setBusy(false);
            return;
          }
          overwrite = true;
        }
        if (targetId === taskId) {
          await ipc.scratchPromote(taskId, tab.scratchId, rel, overwrite);
        } else {
          await ipc.taskFileWrite(taskId, rel, content);
          await ipc.scratchDelete(targetId, tab.scratchId);
        }
        useApp.getState().promoteScratchTab(taskId, tab.id, rel);
        useApp.getState().bumpFsRevision(taskId);
        useApp.getState().bumpGitRevision(taskId);
        useUI.getState().pushToast(t("scratchSave.toastSaved", { name: leaf }), "success");
        resolve(true);
      }
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
      if (hit) {
        e.preventDefault();
        useFolder(hit.f);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }

  if (!req) return null;

  const rootLabel =
    targetScope === "project"
      ? t("scratchSave.projectRoot", "Project scratchpad root")
      : targetScope === "profile"
      ? t("scratchSave.profileRoot", "Profile scratchpad root")
      : targetScope === "global"
      ? t("scratchSave.globalRoot", "Global scratchpad root")
      : t("scratchSave.taskRoot", "task root");

  const dialogTitle =
    targetScope === "project"
      ? t("scratchSave.titleProject", "Save to Project Scratchpad")
      : targetScope === "profile"
      ? t("scratchSave.titleProfile", "Save to Profile Scratchpad")
      : targetScope === "global"
      ? t("scratchSave.titleGlobal", "Save to Global Scratchpad")
      : t("scratchSave.title", "Save to project");

  const dialogDescription =
    targetScope === "project"
      ? t("scratchSave.descProject", "Save this note into your project-scoped scratchpad directory.")
      : targetScope === "profile"
      ? t("scratchSave.descProfile", "Save this note into your profile-scoped scratchpad directory.")
      : targetScope === "global"
      ? t("scratchSave.descGlobal", "Save this note into your global scratchpad directory.")
      : t("scratchSave.description", "Scratchpads live outside the repo until you save them. Pick where this one goes.");

  return (
    <AppDialog
      open
      onOpenChange={v => {
        if (!v) resolve(false);
      }}
      title={dialogTitle}
      description={dialogDescription}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-3 pt-1" onKeyDown={onKeyDown}>
        {/* Destination selector */}
        <div className="flex items-center gap-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] p-1">
          <button
            type="button"
            onClick={() => setTargetScope("project")}
            disabled={!task?.project_id}
            className={cn(
              "flex-1 rounded py-1 px-2 text-center text-[12px] font-medium transition-colors",
              targetScope === "project"
                ? "bg-[var(--color-bg-1)] text-[var(--color-accent)] shadow-sm"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] disabled:opacity-40"
            )}
          >
            {t("scratchSave.destProject", "Project Scratchpad")}
          </button>
          <button
            type="button"
            onClick={() => setTargetScope("profile")}
            className={cn(
              "flex-1 rounded py-1 px-2 text-center text-[12px] font-medium transition-colors",
              targetScope === "profile"
                ? "bg-[var(--color-bg-1)] text-[var(--color-accent)] shadow-sm"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            )}
          >
            {t("scratchSave.destProfile", "Profile Scratchpad")}
          </button>
          <button
            type="button"
            onClick={() => setTargetScope("global")}
            className={cn(
              "flex-1 rounded py-1 px-2 text-center text-[12px] font-medium transition-colors",
              targetScope === "global"
                ? "bg-[var(--color-bg-1)] text-[var(--color-accent)] shadow-sm"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            )}
          >
            {t("scratchSave.destGlobal", "Global Scratchpad")}
          </button>
          <button
            type="button"
            onClick={() => setTargetScope("workspace")}
            className={cn(
              "flex-1 rounded py-1 px-2 text-center text-[12px] font-medium transition-colors",
              targetScope === "workspace"
                ? "bg-[var(--color-bg-1)] text-[var(--color-accent)] shadow-sm"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            )}
          >
            {t("scratchSave.destWorkspace", "Workspace")}
          </button>
        </div>

        <input
          ref={inputRef}
          data-testid="scratch-save-path"
          value={path}
          onChange={e => setPath(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          placeholder="docs/notes.md"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2 font-mono text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)] focus:outline-none"
        />

        <div className="text-[12px] text-[var(--color-fg-faint)]">
          {t("scratchSave.hint", "Relative to root. Press Tab to complete folder, Enter to save.")}
        </div>

        <div
          ref={listRef}
          className="max-h-[38vh] min-h-[120px] overflow-y-auto rounded-md border border-[var(--color-border-soft)] py-1"
        >
          {matches.length === 0 && (
            <div className="px-3 py-2 text-[13px] text-[var(--color-fg-faint)]">
              {t("scratchSave.noFolder", "Root directory")}
            </div>
          )}
          {matches.map((r, i) => (
            <button
              key={r.f}
              data-row={i}
              type="button"
              onClick={() => useFolder(r.f)}
              onMouseMove={() => setActiveIdx(i)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12.5px]",
                i === activeIdx ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]"
              )}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
              <span className="truncate">
                {r.f ? <Highlighted text={r.f} matches={r.m} /> : <span className="italic">{rootLabel}</span>}
              </span>
            </button>
          ))}
        </div>

        {err && <div className="text-[13px] text-[var(--color-err)]">{err}</div>}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" type="button" onClick={() => resolve(false)}>
          {t("common:cancel")}
        </Button>
        <Button
          variant="primary"
          type="button"
          onClick={() => void save()}
          disabled={busy}
          data-testid="scratch-save-confirm"
        >
          {busy ? t("common:saving") : t("common:save")}
        </Button>
      </div>
    </AppDialog>
  );
}
