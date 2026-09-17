// The webview half of `termic scratchpad list|new|write|read`: an agent's notes for
// the human, in the task's scratchpads.
//
// The server resolves the task; everything about pads happens here, because
// an OPEN pad's truth is its editor buffer (lib/scratchLive). A write to an
// open pad goes into that buffer, so it shows the moment it lands and Cmd+Z
// takes it back; a closed pad is plain scratch IPC.

import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import { livePad } from "@/lib/scratchLive";
import { scratchTab } from "@/lib/scratchTabs";
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

function openPads(taskId: string): Map<string, ScratchTab> {
  return new Map(
    (useApp.getState().tabs[taskId] ?? [])
      .filter((t): t is ScratchTab => t.type === "scratch")
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

async function createPad(taskId: string, title: string | null, content: string): Promise<PadInfo> {
  const id = crypto.randomUUID();
  const fixed = title?.trim() || "";
  const shown = fixed || deriveScratchTitle(content);
  await ipc.scratchWrite(taskId, id, content);
  if (shown) await ipc.scratchSetMeta(taskId, id, { title: shown });
  // Only a task whose tabs are loaded gets a tab now; any other picks the pad
  // up from the index when it is next opened (restoreScratchTabs).
  const tabsLoaded = useApp.getState().tabs[taskId] !== undefined;
  if (tabsLoaded) {
    useApp.getState().addTab(
      taskId,
      // A --title locks, exactly like a double-click rename: the text an
      // agent writes next must not retitle a pad it named on purpose.
      { ...scratchTab({ id, title: shown }), ...(fixed ? { customTitle: true } : {}) },
      // Never steal focus from the human, or from the agent's own terminal.
      { focus: false },
    );
  }
  return { id, title: shown, open: tabsLoaded };
}

async function writePad(taskId: string, info: PadInfo, content: string, append: boolean): Promise<PadInfo> {
  const live = livePad(taskId, info.id);
  if (live) {
    live.write(content, append);
    return info;
  }
  const next = append ? (await ipc.scratchRead(taskId, info.id)) + content : content;
  await ipc.scratchWrite(taskId, info.id, next);
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
      return { pads: [await writePad(p.taskId, info, p.content, !!p.append)] };
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
