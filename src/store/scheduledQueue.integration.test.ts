// @vitest-environment happy-dom
// Scheduled queue messages (GH #300) through the store: persisted with the
// tab, restored into its queue, carried through tab-list rewrites, and kicked
// by the minute ticker only when one is due.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabScheduled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn(), focusPaneTab: vi.fn() }));
vi.mock("@/lib/agents", () => ({ agentDisplayName: vi.fn((cli: string) => cli), STICKY_DONE_MS: 8_000 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import { scheduledTickNow } from "@/lib/scheduledTicker";
import type { PersistedTab, TerminalTab } from "@/lib/types";
import { makeTask, makeTerminalTab, resetAppStore, seedTab } from "@/test-utils/store";

const DAY = 24 * 60 * 60 * 1000;
const tabOf = (id: string) => useApp.getState().tabs["ws1"]!.find(t => t.id === id) as TerminalTab;
const recordOf = (id: string) => useApp.getState().tasks[0].persisted_tabs!.find(t => t.id === id)!;

beforeEach(() => {
  resetAppStore();
  vi.clearAllMocks();
});

function seedDurableTab(extra: Partial<TerminalTab> = {}) {
  useApp.setState({ tasks: [makeTask({ persisted_tabs: [{ id: "t1", cli: "claude", is_default: true }] })] });
  seedTab("ws1", makeTerminalTab({ id: "t1", is_default: true, ...extra }));
}

describe("scheduleAgentMessage", () => {
  it("queues a one-shot item, persists it, and does not activate the queue", () => {
    seedDurableTab();
    const at = Date.now() + DAY;
    useApp.getState().scheduleAgentMessage("ws1", "t1", "check the logs", at);

    const t = tabOf("t1");
    expect(t.queue).toHaveLength(1);
    expect(t.queue![0]).toMatchObject({ text: "check the logs", repeat: 1, remaining: 1, notBefore: at });
    expect(t.queueActive).toBeFalsy();
    expect(t.queueKick).toBe(1);
    expect(ipc.taskSetTabScheduled).toHaveBeenCalledWith("ws1", "t1", [
      expect.objectContaining({ text: "check the logs", not_before: at }),
    ]);
    expect(recordOf("t1").scheduled).toHaveLength(1);
  });

  it("writes nothing when the scheduled set is unchanged", () => {
    seedDurableTab();
    useApp.getState().scheduleAgentMessage("ws1", "t1", "x", Date.now() + DAY);
    vi.mocked(ipc.taskSetTabScheduled).mockClear();
    useApp.getState().syncScheduledMessages("ws1", "t1");
    expect(ipc.taskSetTabScheduled).not.toHaveBeenCalled();
  });

  it("removing the item clears it on disk", () => {
    seedDurableTab();
    useApp.getState().scheduleAgentMessage("ws1", "t1", "x", Date.now() + DAY);
    useApp.getState().patchTab("ws1", "t1", { queue: [] });
    useApp.getState().syncScheduledMessages("ws1", "t1");
    expect(ipc.taskSetTabScheduled).toHaveBeenLastCalledWith("ws1", "t1", []);
    expect(recordOf("t1").scheduled).toBeUndefined();
  });
});

describe("restore and tab-list rewrites", () => {
  it("hydrates scheduled items into the restored tab's queue", () => {
    const persisted: PersistedTab[] = [{
      id: "t1", cli: "claude", is_default: true,
      scheduled: [{ id: "m1", text: "check", not_before: 5, created: 1 }],
    }];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    expect(tabOf("t1").queue).toEqual([
      { id: "m1", text: "check", repeat: 1, remaining: 1, notBefore: 5, created: 1 },
    ]);
  });

  it("a tab-list sync keeps the record's schedule and does not rewrite an unchanged list", () => {
    const persisted: PersistedTab[] = [{
      id: "t1", cli: "claude", title: null, custom_title: false, is_default: true, command: null,
      session_id: null, pane_leaf_id: null, run_member: null, pinned: false,
      scheduled: [{ id: "m1", text: "check", not_before: 5, created: 1 }],
    }];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
    seedTab("ws1", makeTerminalTab({ id: "t1", is_default: true, title: "claude" }));
    useApp.getState().syncDurableTabs("ws1");
    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
    expect(recordOf("t1").scheduled).toHaveLength(1);
  });
});

describe("the minute ticker", () => {
  it("writes nothing to the store when nothing is due", () => {
    seedDurableTab({ queue: [{ id: "f", text: "f", repeat: 1, remaining: 1, notBefore: Date.now() + DAY }] });
    const before = useApp.getState();
    expect(scheduledTickNow()).toBe(0);
    expect(useApp.getState()).toBe(before);
  });

  it("kicks a live idle tab with a due item, and skips busy or dead ones", () => {
    const due = [{ id: "d", text: "d", repeat: 1, remaining: 1, notBefore: Date.now() - 1 }];
    useApp.setState({ tasks: [makeTask()] });
    seedTab("ws1", makeTerminalTab({ id: "idle", queue: due }));
    seedTab("ws1", makeTerminalTab({ id: "busy", queue: due, workState: "working" }));
    seedTab("ws1", makeTerminalTab({ id: "dead", queue: due, ptyId: undefined }));
    expect(scheduledTickNow()).toBe(1);
    expect(tabOf("idle").queueKick).toBe(1);
    expect(tabOf("busy").queueKick).toBeUndefined();
    expect(tabOf("dead").queueKick).toBeUndefined();
  });
});
