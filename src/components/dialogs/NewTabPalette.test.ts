// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { DEFAULT_BINDINGS, SHORTCUT_DEFS } from "@/lib/shortcuts";
import { fuzzyMatch } from "@/lib/fuzzy";
import { getScratchScopes } from "@/components/dialogs/NewTabPalette";
import type { Agent, Task } from "@/lib/types";

describe("NewTabPalette state and shortcut", () => {
  beforeEach(() => {
    useUI.setState({ newTabPalette: null });
  });

  it("has a new-tab shortcut registered with Cmd+T / Ctrl+T", () => {
    const def = SHORTCUT_DEFS.find(d => d.id === "new-tab");
    expect(def).toBeDefined();
    expect(def?.group).toBe("Tabs");
    expect(DEFAULT_BINDINGS["new-tab"]).toEqual({
      key: "t",
      cmd: true,
      shift: false,
      alt: false,
    });
  });

  it("toggles newTabPalette in UI store with taskId and paneId", () => {
    expect(useUI.getState().newTabPalette).toBeNull();
    useUI.getState().openNewTabPalette("task-123");
    expect(useUI.getState().newTabPalette).toEqual({ taskId: "task-123", paneId: undefined });

    useUI.getState().openNewTabPalette("task-123", "pane-abc");
    expect(useUI.getState().newTabPalette).toEqual({ taskId: "task-123", paneId: "pane-abc" });

    useUI.getState().closeNewTabPalette();
    expect(useUI.getState().newTabPalette).toBeNull();
  });
});

describe("NewTabPalette fuzzy search logic", () => {
  const agents: Agent[] = [
    { id: "claude", display_name: "Claude Code", command: "claude", args: [], builtin: true, icon_id: "claude", color: "#d97706" } as Agent,
    { id: "codex", display_name: "Codex CLI", command: "codex", args: [], builtin: true, icon_id: "codex", color: "#10b981" } as Agent,
    { id: "harlequin", display_name: "Harlequin DB", command: "harlequin", args: [], builtin: false, kind: "terminal", icon_id: "lucide:terminal", color: "#9aa0a6" } as Agent,
    { id: "lazysql", display_name: "LazySQL", command: "lazysql", args: [], builtin: false, kind: "terminal", icon_id: "lucide:terminal", color: "#9aa0a6" } as Agent,
  ];

  it("matches custom terminals by title and command", () => {
    const custom = agents.filter(a => a.kind === "terminal");
    const m1 = fuzzyMatch(custom[0].display_name, "harle");
    expect(m1).not.toBeNull();

    const m2 = fuzzyMatch(custom[1].command || "", "lazy");
    expect(m2).not.toBeNull();
  });

  it("matches AI agents by display name", () => {
    const aiAgents = agents.filter(a => !a.kind);
    const m1 = fuzzyMatch(aiAgents[0].display_name, "claude");
    expect(m1).not.toBeNull();

    const m2 = fuzzyMatch(aiAgents[1].display_name, "codex");
    expect(m2).not.toBeNull();
  });

  it("identifies custom command runner when query is not an exact match", () => {
    const query = "psql -U postgres -d mydb";
    const exactMatch = agents.some(a => a.display_name.toLowerCase() === query.toLowerCase());
    expect(exactMatch).toBe(false);
  });

  it("creates a tab with initialInput ending in CR to execute in terminal", () => {
    const query = "echo some text";
    const tabOpts = {
      title: query,
      command: query,
      initialInput: `${query}\r`,
    };
    expect(tabOpts.initialInput).toBe("echo some text\r");

    const tabId = useApp.getState().addPaneTab("task-1", "pane-1", "shell", tabOpts);
    const tabs = useApp.getState().tabs["task-1"] || [];
    const created = tabs.find(t => t.id === tabId);
    expect(created).toBeDefined();
    expect(created?.type).toBe("terminal");
    expect(created?.title).toBe("echo some text");
    expect((created as any)?.initialInput).toBe("echo some text\r");
    expect((created as any)?.command).toBe("echo some text");
  });

  it("resumes a closed tab into a split pane when paneId is provided", () => {
    useApp.setState({
      closedTabs: {
        "task-1": [{
          id: "closed-1",
          tabId: "old-tab-1",
          title: "Closed Tab",
          cli: "shell",
          closedAt: new Date().toISOString(),
          isDefault: false,
        }],
      },
    });
    useApp.getState().resumeClosedTab("task-1", "closed-1", { paneId: "pane-1" });
    const tabs = useApp.getState().tabs["task-1"] || [];
    const resumed = tabs.find(t => t.id === "old-tab-1");
    expect(resumed).toBeDefined();
    expect((resumed as any)?.paneId).toBe("pane-1");
  });

  it("omits project scratchpad scope when task has no project", () => {
    const scopesNoProject = getScratchScopes(k => k, false);
    expect(scopesNoProject.map(s => s.scope)).toEqual(["task", "profile", "global"]);
    expect(scopesNoProject.some(s => s.scope === "project")).toBe(false);

    const scopesWithProject = getScratchScopes(k => k, true);
    expect(scopesWithProject.map(s => s.scope)).toEqual(["task", "project", "profile", "global"]);
    expect(scopesWithProject.some(s => s.scope === "project")).toBe(true);
  });
});
