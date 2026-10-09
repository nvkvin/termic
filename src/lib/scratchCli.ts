// The webview half of `termic scratchpad list|new|write|read`: an agent's notes for
// the human, in the task's scratchpads.
//
// The server resolves the task; everything about pads happens here, because
// an OPEN pad's truth is its editor buffer (lib/scratchLive). A write to an
// open pad goes into that buffer, so it shows the moment it lands and Cmd+Z
// takes it back; a closed pad is plain scratch IPC.

import { isUserWatchingIn, useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import { livePad, padDiskSettled, trackPadDiskWrite } from "@/lib/scratchLive";
import { scratchTab, scratchTargetId } from "@/lib/scratchTabs";
import { deriveScratchTitle, SCRATCH_UNTITLED } from "@/lib/scratchTitle";
import type { ScratchTab } from "@/lib/types";

export interface PadInfo {
  id: string;
  title: string;
  syntax?: string;
  open: boolean;
}

interface PadParams {
  taskId: string;
  op: "list" | "new" | "write" | "read";
  pad?: string;
  title?: string | null;
  content?: string | null;
  append?: boolean;
}

function openPads(targetId: string): Map<string, ScratchTab> {
  const tabsState = useApp.getState().tabs;
  const direct = tabsState[targetId];
  if (direct) {
    return new Map(
      direct.filter((t): t is ScratchTab => t.type === "scratch").map(t => [t.scratchId, t]),
    );
  }
  const allTabs = Object.values(tabsState).flat();
  return new Map(
    allTabs
      .filter((t): t is ScratchTab => t.type === "scratch" && scratchTargetId(t) === targetId)
      .map(t => [t.scratchId, t]),
  );
}

/** Every pad in the task, with the window's title where the pad is open (the
 *  index title lags the derived one by a debounce). */
async function padInfos(taskId: string): Promise<PadInfo[]> {
  const recs = await ipc.scratchList(taskId);
  const open = openPads(taskId);
  return recs.map(rec => {
    const tab = open.get(rec.id);
    const title = tab && tab.title !== SCRATCH_UNTITLED ? tab.title : rec.title;
    const syntax = tab?.syntax ?? rec.syntax;
    return { id: rec.id, title, ...(syntax ? { syntax } : {}), open: !!tab };
  });
}

/** A pad by id, else by exact title (case-insensitive). Ids are the stable
 *  selector; a title is a convenience, so two pads sharing one is an error
 *  that names their ids rather than a guess. */
export async function resolvePad(taskId: string, selector: string): Promise<PadInfo> {
  const infos = await padInfos(taskId);
  const byId = infos.find(p => p.id === selector);
  if (byId) return byId;
  const want = selector.trim().toLowerCase();
  const byTitle = infos.filter(p => p.title.trim().toLowerCase() === want);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw new Error(`"${selector}" matches ${byTitle.length} pads (${byTitle.map(p => p.id).join(", ")}); pass an id`);
  }
  throw new Error(`no pad "${selector}" in this task (see \`termic scratchpad list\`)`);
}

/** Mark a pad changed-but-unseen after a write that did not come from the
 *  user: unless its tab is on screen in a focused window, which is the same
 *  "is the user looking" rule the agent badges use. A pad with no open tab
 *  has nowhere to show it. Bails when already marked (a store write per
 *  append would re-run every mounted selector for nothing). */
function markPadUnseen(taskId: string, scratchId: string) {
  const s = useApp.getState();
  const tabs = s.tabs[taskId];
  if (tabs) {
    const tab = tabs.find((t): t is ScratchTab => t.type === "scratch" && t.scratchId === scratchId);
    if (tab && !tab.unseen && !isUserWatchingIn(s, taskId, tab.id)) {
      s.patchTab(taskId, tab.id, { unseen: true });
      return;
    }
  }
  // If not found in taskId directly (e.g. global/project pad open in another task), find across tasks:
  for (const [tId, tabList] of Object.entries(s.tabs)) {
    const tab = tabList.find(
      (t): t is ScratchTab => t.type === "scratch" && t.scratchId === scratchId && scratchTargetId(t, tId) === taskId,
    );
    if (tab && !tab.unseen && !isUserWatchingIn(s, tId, tab.id)) {
      s.patchTab(tId, tab.id, { unseen: true });
      return;
    }
  }
}

async function createPad(taskId: string, title: string | null, content: string): Promise<PadInfo> {
  const id = crypto.randomUUID();
  const fixed = title?.trim() || "";
  const shown = fixed || deriveScratchTitle(content);
  await trackPadDiskWrite(taskId, id, ipc.scratchWrite(taskId, id, content));
  if (shown) await ipc.scratchSetMeta(taskId, id, { title: shown });

  const isGlobal = taskId === "global";
  const isProfile = taskId.startsWith("profile_");
  const isProject = taskId.startsWith("project_");
  const scope: "task" | "project" | "profile" | "global" = isGlobal
    ? "global"
    : isProfile
    ? "profile"
    : isProject
    ? "project"
    : "task";
  const projectId = isProject
    ? taskId.slice("project_".length)
    : isProfile
    ? taskId.slice("profile_".length)
    : undefined;

  const hostTaskId = (!isGlobal && !isProject && !isProfile) ? taskId : useApp.getState().activeTaskId;
  const tabsLoaded = hostTaskId ? useApp.getState().tabs[hostTaskId] !== undefined : false;
  if (hostTaskId && tabsLoaded) {
    useApp.getState().addTab(
      hostTaskId,
      {
        ...scratchTab({ id, title: shown, scope, projectId, targetId: taskId }),
        ...(fixed ? { customTitle: true } : {}),
      },
      { focus: false },
    );
    markPadUnseen(hostTaskId, id);
  }
  return { id, title: shown, open: tabsLoaded };
}

async function writePad(taskId: string, info: PadInfo, content: string, append: boolean): Promise<PadInfo> {
  const live = livePad(taskId, info.id);
  if (live) {
    live.write(content, append);
    return info;
  }
  // Tracked from HERE, synchronously after the live check, and covering the
  // read too. Tracking only the final write left the read's await open: an
  // editor mounting meanwhile passed its re-read check, registered, and the
  // write then landed on disk behind it. `prior` is taken first so this write
  // does not wait on itself; an unmounting editor's last flush may still be
  // on its way to the file.
  const prior = padDiskSettled(taskId, info.id);
  const next = await trackPadDiskWrite(taskId, info.id, (async () => {
    await prior;
    const text = append ? (await ipc.scratchRead(taskId, info.id)) + content : content;
    await ipc.scratchWrite(taskId, info.id, text);
    return text;
  })());
  // A closed pad has no editor to derive its title, so an untitled one takes
  // it from the text now; a named one keeps its name.
  if (!info.title) {
    const derived = deriveScratchTitle(next);
    if (derived) {
      await ipc.scratchSetMeta(taskId, info.id, { title: derived });
      return { ...info, title: derived };
    }
  }
  return info;
}

export async function padHandler(raw: unknown): Promise<{ pads: PadInfo[]; content?: string }> {
  const p = raw as PadParams;
  if (typeof p?.taskId !== "string" || !p.taskId) throw new Error("pad requires a taskId");
  switch (p.op) {
    case "list":
      return { pads: await padInfos(p.taskId) };
    case "new":
      return { pads: [await createPad(p.taskId, p.title ?? null, p.content ?? "")] };
    case "write": {
      if (typeof p.pad !== "string" || typeof p.content !== "string") {
        throw new Error("pad write requires a pad and content");
      }
      const info = await resolvePad(p.taskId, p.pad);
      const written = await writePad(p.taskId, info, p.content, !!p.append);
      markPadUnseen(p.taskId, info.id);
      return { pads: [written] };
    }
    case "read": {
      if (typeof p.pad !== "string") throw new Error("pad read requires a pad");
      const info = await resolvePad(p.taskId, p.pad);
      const live = livePad(p.taskId, info.id);
      const content = live ? live.text() : await ipc.scratchRead(p.taskId, info.id);
      return { pads: [info], content };
    }
    default:
      throw new Error(`unknown pad op ${String((p as { op?: unknown }).op)}`);
  }
}
