// @vitest-environment happy-dom
//
// `termic pad` through the webview handler: an agent's notes land in the
// task's scratchpads, open ones update in place, and nothing steals focus.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  scratchList: vi.fn().mockResolvedValue([]),
  scratchRead: vi.fn().mockResolvedValue(""),
  scratchWrite: vi.fn().mockResolvedValue(undefined),
  scratchSetMeta: vi.fn().mockResolvedValue(undefined),
  scratchDelete: vi.fn().mockResolvedValue(undefined),
  scratchPromote: vi.fn().mockResolvedValue(undefined),
  scratchPromoteTargetExists: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(), focusMainTab: vi.fn(), focusPaneTab: vi.fn(),
}));
vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli),
  isTerminalCli: vi.fn(() => false),
  STICKY_DONE_MS: 8_000,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import * as ipc from "@/lib/ipc";
import { useApp } from "@/store/app";
import { padHandler } from "@/lib/scratchCli";
import { registerLivePad } from "@/lib/scratchLive";
import type { ScratchTab } from "@/lib/types";

const TASK = "task-1";
const rec = (id: string, title: string) => ({ id, title, order: 0, created_at: "t", updated_at: "t" });

function pads(): ScratchTab[] {
  return (useApp.getState().tabs[TASK] ?? []).filter((t): t is ScratchTab => t.type === "scratch");
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ tabs: {}, activeTab: {}, tasks: [], closedTabs: {} });
});

describe("pad new", () => {
  it("creates a titled, seeded pad as an UNFOCUSED tab in an open task", async () => {
    useApp.setState({ tabs: { [TASK]: [] }, activeTab: { [TASK]: "agent-tab" } });
    const r = await padHandler({ taskId: TASK, op: "new", title: "findings", content: "# Results\n" });
    const [pad] = pads();
    expect(r.pads[0]).toMatchObject({ id: pad.scratchId, title: "findings", open: true });
    expect(pad.title).toBe("findings");
    // A named pad keeps its name however the agent's text changes.
    expect(pad.customTitle).toBe(true);
    expect(useApp.getState().activeTab[TASK]).toBe("agent-tab");
    expect(ipc.scratchWrite).toHaveBeenCalledWith(TASK, pad.scratchId, "# Results\n");
    expect(ipc.scratchSetMeta).toHaveBeenCalledWith(TASK, pad.scratchId, { title: "findings" });
  });

  it("names an untitled pad after its text", async () => {
    useApp.setState({ tabs: { [TASK]: [] } });
    const r = await padHandler({ taskId: TASK, op: "new", content: "release log check" });
    expect(r.pads[0].title).toBe("release log check");
    expect(pads()[0].customTitle).toBeFalsy();
  });

  it("only writes the record when the task is not open, for restore to pick up", async () => {
    const r = await padHandler({ taskId: TASK, op: "new", content: "" });
    expect(r.pads[0].open).toBe(false);
    expect(useApp.getState().tabs[TASK]).toBeUndefined();
    expect(ipc.scratchWrite).toHaveBeenCalledTimes(1);
  });
});

describe("pad write / read", () => {
  it("writes INTO an open pad's buffer instead of behind it", async () => {
    vi.mocked(ipc.scratchList).mockResolvedValue([rec("p1", "notes")]);
    let buf = "old";
    const unregister = registerLivePad(TASK, "p1", {
      text: () => buf,
      write: (t, append) => { buf = append ? buf + t : t; },
    });
    try {
      await padHandler({ taskId: TASK, op: "write", pad: "NOTES", content: " + new", append: true });
      expect(buf).toBe("old + new");
      // The editor flushes; the handler must not race it with a stale write.
      expect(ipc.scratchWrite).not.toHaveBeenCalled();
      const r = await padHandler({ taskId: TASK, op: "read", pad: "p1" });
      expect(r.content).toBe("old + new");
      expect(ipc.scratchRead).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("appends to a closed pad on disk and titles it if it had none", async () => {
    vi.mocked(ipc.scratchList).mockResolvedValue([rec("p2", "")]);
    vi.mocked(ipc.scratchRead).mockResolvedValueOnce("first line\n");
    const r = await padHandler({ taskId: TASK, op: "write", pad: "p2", content: "second", append: true });
    expect(ipc.scratchWrite).toHaveBeenCalledWith(TASK, "p2", "first line\nsecond");
    expect(r.pads[0].title).toBe("first line second");
  });

  it("refuses a title two pads share, naming their ids", async () => {
    vi.mocked(ipc.scratchList).mockResolvedValue([rec("a", "Notes"), rec("b", "notes")]);
    await expect(padHandler({ taskId: TASK, op: "read", pad: "notes" })).rejects.toThrow(/a, b/);
  });

  it("says so when no pad matches", async () => {
    vi.mocked(ipc.scratchList).mockResolvedValue([]);
    await expect(padHandler({ taskId: TASK, op: "read", pad: "nope" })).rejects.toThrow(/no pad "nope"/);
  });
});

describe("pad list", () => {
  it("prefers the open tab's live title and marks what is open", async () => {
    vi.mocked(ipc.scratchList).mockResolvedValue([rec("p1", "stale"), rec("p2", "closed one")]);
    useApp.setState({ tabs: { [TASK]: [{ id: "t1", type: "scratch", scratchId: "p1", title: "fresh", dirty: true }] } });
    const r = await padHandler({ taskId: TASK, op: "list" });
    expect(r.pads).toEqual([
      { id: "p1", title: "fresh", open: true },
      { id: "p2", title: "closed one", open: false },
    ]);
  });
});
