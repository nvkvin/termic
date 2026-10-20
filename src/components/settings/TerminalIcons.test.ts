// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    settingsLoad: vi.fn().mockResolvedValue({
      agents: [
        { id: "claude", display_name: "Claude Code", command: "claude", args: [], builtin: true, icon_id: "claude", color: "#d97706" },
        { id: "term-db", display_name: "DB Client", command: "harlequin", args: [], builtin: false, kind: "terminal", icon_id: "database", color: "#f59e0b" },
      ],
    }),
    agentsDefaults: vi.fn().mockResolvedValue([]),
    agentsSave: vi.fn().mockResolvedValue(undefined),
    projectUpdate: vi.fn().mockResolvedValue(undefined),
    agentHooksAutoGet: vi.fn().mockResolvedValue(false),
  };
});

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TOOL_ICONS, CLI_BRAND_COLOR, resolveIconId, CliIcon } from "@/icons/cli";
import { isTerminalEntry } from "@/lib/agents";
import type { Agent } from "@/lib/types";
import { i18n } from "@/lib/i18n";
import { AgentsSection } from "./AgentsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Tool Icons and CLI Brand Colors", () => {
  it("exports a curated list of tool icons including database and server", () => {
    expect(TOOL_ICONS.length).toBeGreaterThanOrEqual(10);
    const ids = TOOL_ICONS.map(i => i.id);
    expect(ids).toContain("terminal");
    expect(ids).toContain("database");
    expect(ids).toContain("server");
    expect(ids).toContain("globe");
    expect(ids).toContain("cpu");
    expect(ids).toContain("box");
    expect(ids).toContain("git");
  });

  it("assigns distinct brand colors for tool icons", () => {
    expect(CLI_BRAND_COLOR.database).toBe("text-amber-500");
    expect(CLI_BRAND_COLOR.server).toBe("text-emerald-500");
    expect(CLI_BRAND_COLOR.globe).toBe("text-sky-500");
    expect(CLI_BRAND_COLOR.cpu).toBe("text-purple-500");
    expect(CLI_BRAND_COLOR.box).toBe("text-orange-500");
  });

  it("resolves custom icon_id on custom terminals", () => {
    const agents: Agent[] = [
      { id: "term-db", display_name: "DB Client", command: "harlequin", args: [], builtin: false, kind: "terminal", icon_id: "database", color: "#f59e0b" } as Agent,
      { id: "term-server", display_name: "Web Server", command: "npm run dev", args: [], builtin: false, kind: "terminal", icon_id: "server", color: "#10b981" } as Agent,
      { id: "claude", display_name: "Claude Code", command: "claude", args: [], builtin: true, icon_id: "claude", color: "#d97706" } as Agent,
    ];

    expect(resolveIconId("term-db", agents)).toBe("database");
    expect(resolveIconId("term-server", agents)).toBe("server");
    expect(resolveIconId("claude", agents)).toBe("claude");
  });

  it("distinguishes between AI agents and terminal tools", () => {
    const agent: Agent = { id: "claude", display_name: "Claude", command: "claude", args: [], builtin: true, icon_id: "claude", color: "#d97706" } as Agent;
    const terminal: Agent = { id: "term-1", display_name: "DB", command: "psql", args: [], builtin: false, kind: "terminal", icon_id: "database", color: "#f59e0b" } as Agent;

    expect(isTerminalEntry(agent)).toBe(false);
    expect(isTerminalEntry(terminal)).toBe(true);
  });

  it("renders AgentsSection without hook errors during initial mount and load", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(AgentsSection));
    });

    // Allow async load effects to resolve and re-render
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });

    const filterAll = container.querySelector('[data-testid="filter-all"]');
    const filterAgents = container.querySelector('[data-testid="filter-agents"]');
    const filterTerminals = container.querySelector('[data-testid="filter-terminals"]');
    expect(filterAll).not.toBeNull();
    expect(filterAgents).not.toBeNull();
    expect(filterTerminals).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
