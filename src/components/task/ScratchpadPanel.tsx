// Dedicated Scratchpad panel for the Right Panel (GH common-scratchpad).
//
// Shows two distinct collapsible trees:
// 1. Project Scratchpad: scoped to the current project, shared across all its tasks.
// 2. Global Scratchpad: machine-wide, shared across all projects and tasks.
//
// Users can create, open, rename, and delete files and folders, and export
// any scratchpad file directly into the local workspace git worktree.

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight, ChevronDown, FilePlus, FolderPlus,
  RefreshCw, Pencil, Trash2, ArrowRightFromLine, FolderOpen,
} from "lucide-react";
import type { FileEntry } from "@/lib/types";
import * as ipc from "@/lib/ipc";
import { openScratchFileTab } from "@/lib/scratchTabs";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useProfiles } from "@/store/profiles";
import { cn } from "@/lib/utils";
import { fileIconUrl, folderIconUrl } from "@/lib/explorer/iconResolver";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/ContextMenu";
import { Tip } from "@/components/ui/Tooltip";
import { FILE_MANAGER } from "@/lib/openExternal";

interface ScratchpadPanelProps {
  taskId: string;
  projectId?: string;
  reloadToken?: number;
}

type Scope = "project" | "profile" | "global";

interface CreatingState {
  parentRel: string;
  isDir: boolean;
}

export function ScratchpadPanel({ taskId, projectId, reloadToken = 0 }: ScratchpadPanelProps) {
  const { t } = useTranslation("task");
  const profileSlug = useProfiles(s => s.current);

  return (
    <div className="flex flex-col select-none divide-y divide-[var(--color-border-soft)]">
      {/* Project Scratchpad */}
      <ScratchpadSection
        scope="project"
        title={t("scratchpad.projectTitle", "Project Scratchpad")}
        badge={t("scratchpad.projectBadge", "Project")}
        taskId={taskId}
        projectId={projectId}
        reloadToken={reloadToken}
      />

      {/* Profile Scratchpad */}
      <ScratchpadSection
        scope="profile"
        title={t("scratchpad.profileTitle", "Profile Scratchpad")}
        badge={t("scratchpad.profileBadge", "Profile")}
        taskId={taskId}
        projectId={profileSlug ?? undefined}
        reloadToken={reloadToken}
      />

      {/* Global Scratchpad */}
      <ScratchpadSection
        scope="global"
        title={t("scratchpad.globalTitle", "Global Scratchpad")}
        badge={t("scratchpad.globalBadge", "Global")}
        taskId={taskId}
        projectId={undefined}
        reloadToken={reloadToken}
      />
    </div>
  );
}

interface SectionProps {
  scope: Scope;
  title: string;
  badge: string;
  taskId: string;
  projectId?: string;
  reloadToken: number;
}

function ScratchpadSection({ scope, title, badge, taskId, projectId, reloadToken }: SectionProps) {
  const { t } = useTranslation("task");
  const [collapsed, setCollapsed] = useState(false);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [createDraft, setCreateDraft] = useState("");
  const createInputRef = useRef<HTMLInputElement | null>(null);

  const isProject = scope === "project";
  const disabled = isProject && !projectId;

  const loadRoot = useCallback(async () => {
    if (disabled) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const list = await ipc.scratchTreeList(scope, projectId, "");
      setEntries(list);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [scope, projectId, disabled]);

  const loadSubdir = useCallback(async (rel: string) => {
    if (disabled) return;
    try {
      const list = await ipc.scratchTreeList(scope, projectId, rel);
      setChildren(c => ({ ...c, [rel]: list }));
    } catch {
      setChildren(c => ({ ...c, [rel]: [] }));
    }
  }, [scope, projectId, disabled]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot, reloadToken]);

  // Re-fetch all open subdirs on external reloadToken bump
  useEffect(() => {
    if (reloadToken === 0) return;
    for (const dir of expanded) {
      void loadSubdir(dir);
    }
  }, [reloadToken, expanded, loadSubdir]);

  const toggleFolder = useCallback((rel: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(rel)) {
        next.delete(rel);
      } else {
        next.add(rel);
        void loadSubdir(rel);
      }
      return next;
    });
  }, [loadSubdir]);

  function startCreating(parentRel: string, isDir: boolean) {
    if (disabled) return;
    setCreating({ parentRel, isDir });
    setCreateDraft("");
    if (parentRel && !expanded.has(parentRel)) {
      toggleFolder(parentRel);
    }
  }

  useEffect(() => {
    if (!creating) return;
    requestAnimationFrame(() => {
      createInputRef.current?.focus();
    });
  }, [creating]);

  async function submitCreate() {
    if (!creating) return;
    const name = createDraft.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    const parentRel = creating.parentRel;
    const isDir = creating.isDir;
    const fullRel = parentRel ? `${parentRel}/${name}` : name;
    setCreating(null);
    try {
      await ipc.scratchFileCreate(scope, projectId, fullRel, isDir);
      if (parentRel) {
        await loadSubdir(parentRel);
      } else {
        await loadRoot();
      }
      if (!isDir) {
        openScratchFileTab(taskId, scope, projectId, fullRel);
      }
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
  }

  return (
    <div className="flex flex-col">
      {/* Section Header */}
      <div
        className="group flex h-8 items-center justify-between px-2 text-[12px] font-semibold text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] cursor-pointer"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
          )}
          <span className="truncate">{title}</span>
          <span className="shrink-0 rounded px-1 py-0.2 bg-[var(--color-bg-2)] text-[10px] text-[var(--color-fg-faint)]">
            {badge}
          </span>
        </div>

        <div
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={e => e.stopPropagation()}
        >
          <Tip content={t("scratchpad.newFile", "New file")} side="bottom">
            <button
              onClick={() => startCreating("", false)}
              disabled={disabled}
              className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-40"
            >
              <FilePlus className="h-3.5 w-3.5" />
            </button>
          </Tip>
          <Tip content={t("scratchpad.newFolder", "New folder")} side="bottom">
            <button
              onClick={() => startCreating("", true)}
              disabled={disabled}
              className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-40"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </Tip>
          <Tip content={t("scratchpad.revealInFinder", { manager: FILE_MANAGER, defaultValue: `Reveal in ${FILE_MANAGER}` })} side="bottom">
            <button
              onClick={() => { void ipc.scratchPathReveal(scope, projectId, "").catch((e: unknown) => useUI.getState().pushToast(String(e), "error")); }}
              disabled={disabled}
              className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-40"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          </Tip>
          <Tip content={t("common:refresh", "Refresh")} side="bottom">
            <button
              onClick={() => { void loadRoot(); }}
              disabled={disabled}
              className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-40"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </Tip>
        </div>
      </div>

      {/* Section Content */}
      {!collapsed && (
        <div className="flex flex-col py-0.5">
          {disabled ? (
            <div className="px-5 py-2 text-[12px] text-[var(--color-fg-faint)] italic">
              {t("scratchpad.noProject", "Current task has no associated project.")}
            </div>
          ) : (
            <>
              {/* Root Creation Input */}
              {creating && creating.parentRel === "" && (
                <div className="flex items-center gap-1.5 px-5 py-1">
                  <img
                    src={creating.isDir ? folderIconUrl("folder", false) : fileIconUrl(createDraft || "txt")}
                    alt=""
                    className="h-3.5 w-3.5 shrink-0 file-icon"
                  />
                  <input
                    ref={createInputRef}
                    type="text"
                    value={createDraft}
                    onChange={e => setCreateDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") void submitCreate();
                      if (e.key === "Escape") setCreating(null);
                    }}
                    onBlur={() => void submitCreate()}
                    placeholder={creating.isDir ? "folder-name" : "filename.md"}
                    className="h-6 w-full rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 font-mono text-[12px] text-[var(--color-fg)] outline-none"
                  />
                </div>
              )}

              {/* Entries list */}
              {entries && entries.length === 0 && !creating ? (
                <div className="px-5 py-2 text-[12px] text-[var(--color-fg-faint)] italic">
                  {t("scratchpad.empty", "No scratchpad files yet.")}
                </div>
              ) : (
                entries?.map(entry => (
                  <ScratchTreeNode
                    key={entry.name}
                    taskId={taskId}
                    scope={scope}
                    projectId={projectId}
                    entry={entry}
                    depth={0}
                    rel={entry.name}
                    expanded={expanded}
                    children_={children}
                    toggle={toggleFolder}
                    creating={creating}
                    createDraft={createDraft}
                    setCreateDraft={setCreateDraft}
                    createInputRef={createInputRef}
                    submitCreate={submitCreate}
                    cancelCreate={() => setCreating(null)}
                    startCreating={startCreating}
                    refetchDir={rel => rel ? loadSubdir(rel) : loadRoot()}
                  />
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface NodeProps {
  taskId: string;
  scope: Scope;
  projectId?: string;
  entry: FileEntry;
  depth: number;
  rel: string;
  expanded: Set<string>;
  children_: Record<string, FileEntry[]>;
  toggle: (rel: string) => void;
  creating: CreatingState | null;
  createDraft: string;
  setCreateDraft: (v: string) => void;
  createInputRef: React.RefObject<HTMLInputElement | null>;
  submitCreate: () => void;
  cancelCreate: () => void;
  startCreating: (parentRel: string, isDir: boolean) => void;
  refetchDir: (rel: string) => Promise<void>;
}

function ScratchTreeNode({
  taskId,
  scope,
  projectId,
  entry,
  depth,
  rel,
  expanded,
  children_,
  toggle,
  creating,
  createDraft,
  setCreateDraft,
  createInputRef,
  submitCreate,
  cancelCreate,
  startCreating,
  refetchDir,
}: NodeProps) {
  const { t } = useTranslation("task");
  const closeTab = useApp(s => s.closeTab);
  const tabs = useApp(s => s.tabs[taskId] || []);
  const activeTabId = useApp(s => s.activeTab[taskId]);
  const isOpen = expanded.has(rel);
  const kids = children_[rel];

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(entry.name);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!renaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renaming]);

  const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

  function closeStaleTabs(targetPath: string) {
    for (const tab of tabs) {
      if (
        tab.type === "scratch" &&
        tab.scope === scope &&
        (scope === "global" || scope === "profile" || tab.projectId === projectId) &&
        tab.path &&
        (tab.path === targetPath || tab.path.startsWith(`${targetPath}/`))
      ) {
        closeTab(taskId, tab.id);
      }
    }
  }

  async function submitRename() {
    const nextName = renameDraft.trim();
    if (!nextName || nextName === entry.name) {
      setRenaming(false);
      return;
    }
    setRenaming(false);
    try {
      await ipc.scratchPathRename(scope, projectId, rel, nextName);
      closeStaleTabs(rel);
      await refetchDir(parentRel);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
  }

  async function remove() {
    const ok = await useUI.getState().askConfirm({
      title: t("scratchpad.deleteTitle", { name: entry.name, defaultValue: `Delete ${entry.name}?` }),
      message: entry.is_dir
        ? t("scratchpad.deleteDirMessage", "This folder and its contents will be permanently deleted.")
        : t("scratchpad.deleteFileMessage", "This file will be permanently deleted."),
      confirmLabel: t("common:delete", "Delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await ipc.scratchPathDelete(scope, projectId, rel);
      closeStaleTabs(rel);
      await refetchDir(parentRel);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
  }

  const activeTab = tabs.find(t => t.id === activeTabId);
  const isActive =
    activeTab?.type === "scratch" &&
    activeTab.scope === scope &&
    (scope === "global" || scope === "profile" || activeTab.projectId === projectId) &&
    activeTab.path === rel;

  function onClick() {
    if (entry.is_dir) {
      toggle(rel);
    } else {
      openScratchFileTab(taskId, scope, projectId, rel);
    }
  }

  const indentPx = 12 + depth * 14;

  return (
    <div>
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>
          <div
            onClick={onClick}
            style={{ paddingLeft: `${indentPx}px` }}
            className={cn(
              "group flex h-7 items-center gap-1.5 pr-2 text-[12.5px] cursor-pointer hover:bg-[var(--color-hover)]",
              isActive && "bg-[var(--color-active)] text-[var(--color-accent)] font-medium"
            )}
          >
            {entry.is_dir ? (
              <span
                onClick={e => {
                  e.stopPropagation();
                  toggle(rel);
                }}
                className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--color-fg-faint)]"
              >
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </span>
            ) : (
              <span className="w-4 shrink-0" />
            )}

            <img
              src={entry.is_dir ? folderIconUrl(entry.name, isOpen) : fileIconUrl(entry.name)}
              alt=""
              className="h-3.5 w-3.5 shrink-0 file-icon"
            />

            {renaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameDraft}
                onChange={e => setRenameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") void submitRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={() => void submitRename()}
                onClick={e => e.stopPropagation()}
                className="h-5 w-full rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1 font-mono text-[12px] text-[var(--color-fg)] outline-none"
              />
            ) : (
              <span className="truncate">{entry.name}</span>
            )}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {!entry.is_dir && (
            <ContextMenuItem onSelect={() => openScratchFileTab(taskId, scope, projectId, rel)}>
              {t("common:open", "Open")}
            </ContextMenuItem>
          )}

          {entry.is_dir && (
            <>
              <ContextMenuItem onSelect={() => startCreating(rel, false)}>
                <FilePlus className="mr-2 h-4 w-4" />
                {t("scratchpad.newFile", "New file...")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => startCreating(rel, true)}>
                <FolderPlus className="mr-2 h-4 w-4" />
                {t("scratchpad.newFolder", "New folder...")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}

          <ContextMenuItem onSelect={() => { setRenameDraft(entry.name); setRenaming(true); }}>
            <Pencil className="mr-2 h-4 w-4" />
            {t("common:rename", "Rename")}
          </ContextMenuItem>

          {!entry.is_dir && (
            <ContextMenuItem
              onSelect={() => {
                useUI.getState().openScratchExport({
                  scope,
                  projectId,
                  scratchPath: rel,
                  taskId,
                  defaultRel: entry.name,
                });
              }}
            >
              <ArrowRightFromLine className="mr-2 h-4 w-4" />
              {t("scratchpad.saveToWorkspace", "Save to workspace...")}
            </ContextMenuItem>
          )}

          <ContextMenuItem
            onSelect={() => {
              void ipc.scratchPathReveal(scope, projectId, rel).catch((e: unknown) => {
                useUI.getState().pushToast(String(e), "error");
              });
            }}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            {entry.is_dir
              ? t("scratchpad.openInManager", { manager: FILE_MANAGER, defaultValue: `Open in ${FILE_MANAGER}` })
              : t("scratchpad.revealInManager", { manager: FILE_MANAGER, defaultValue: `Reveal in ${FILE_MANAGER}` })}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem onSelect={() => void remove()} className="text-[var(--color-danger)]">
            <Trash2 className="mr-2 h-4 w-4" />
            {t("common:delete", "Delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>

      {/* Subdirectory Children */}
      {entry.is_dir && isOpen && (
        <div>
          {/* Subdir creation input */}
          {creating && creating.parentRel === rel && (
            <div
              style={{ paddingLeft: `${indentPx + 16}px` }}
              className="flex items-center gap-1.5 py-1 pr-2"
            >
              <img
                src={creating.isDir ? folderIconUrl("folder", false) : fileIconUrl(createDraft || "txt")}
                alt=""
                className="h-3.5 w-3.5 shrink-0 file-icon"
              />
              <input
                ref={createInputRef}
                type="text"
                value={createDraft}
                onChange={e => setCreateDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") void submitCreate();
                  if (e.key === "Escape") cancelCreate();
                }}
                onBlur={() => void submitCreate()}
                placeholder={creating.isDir ? "folder-name" : "filename.md"}
                className="h-5 w-full rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1 font-mono text-[12px] text-[var(--color-fg)] outline-none"
              />
            </div>
          )}

          {kids?.map(child => (
            <ScratchTreeNode
              key={child.name}
              taskId={taskId}
              scope={scope}
              projectId={projectId}
              entry={child}
              depth={depth + 1}
              rel={`${rel}/${child.name}`}
              expanded={expanded}
              children_={children_}
              toggle={toggle}
              creating={creating}
              createDraft={createDraft}
              setCreateDraft={setCreateDraft}
              createInputRef={createInputRef}
              submitCreate={submitCreate}
              cancelCreate={cancelCreate}
              startCreating={startCreating}
              refetchDir={refetchDir}
            />
          ))}
        </div>
      )}
    </div>
  );
}
