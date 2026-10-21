// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  settingsLoad: vi.fn(), customizationsOpen: vi.fn(), customizationsSetEnabled: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ipc);
import { i18n } from "@/lib/i18n";
import { AgentCustomizationsBlock } from "./AgentCustomizationsBlock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const button = () => host.querySelector<HTMLButtonElement>('[data-testid="customizations-open"]')!;

beforeEach(async () => {
  vi.resetAllMocks();
  ipc.settingsLoad.mockResolvedValue({ customizations_enabled: null });
  ipc.customizationsSetEnabled.mockResolvedValue(undefined);
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(AgentCustomizationsBlock)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("agent customizations", () => {
  it("opens only on demand and displays the exact backend path", async () => {
    expect(ipc.customizationsOpen).not.toHaveBeenCalled();
    const path = "/Users/alice/Library/Application Support/termic_dev/profiles/work/customizations";
    ipc.customizationsOpen.mockResolvedValue(path);
    await act(async () => button().click());
    expect(host.querySelector('[data-testid="customizations-path"]')?.textContent).toBe(path);
    expect(host.textContent).toContain("Use profile customizations by default");
  });

  it("prevents duplicate opens, surfaces failure, and allows retry", async () => {
    let reject!: (error: Error) => void;
    ipc.customizationsOpen.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await act(async () => { button().click(); button().click(); });
    expect(ipc.customizationsOpen).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    await act(async () => reject(new Error("Folder is not writable")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Folder is not writable");
    expect(button().disabled).toBe(false);
    ipc.customizationsOpen.mockResolvedValue("/Users/alice/customizations");
    await act(async () => button().click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[data-testid="customizations-path"]')?.textContent).toBe("/Users/alice/customizations");
  });

  it("persists the profile default and restores the backend value after a failed save", async () => {
    const toggle = () => host.querySelector<HTMLButtonElement>('[data-testid="customizations-default"] [role="switch"]')!;
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle().click());
    expect(ipc.customizationsSetEnabled).toHaveBeenCalledWith(false);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    ipc.customizationsSetEnabled.mockRejectedValue(new Error("Could not save"));
    ipc.settingsLoad.mockResolvedValue({ customizations_enabled: false });
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  });
});
