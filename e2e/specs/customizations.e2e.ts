import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import { clickWhenVisible, dismissOverlays, requireTermicApi, snap, textOf, waitForAppShell, waitGone, waitVisible } from "../helpers";

// Own only the disposable fixture's customization files; restore them even after failure.
describe("profile agent customizations", () => {
  const folder = path.join(dataDir, "customizations");
  const openedLog = path.join(dataDir, "e2e-opened.log");
  let backup: string;
  let hadFolder = false;
  let originalLog: string | null = null;
  let originalDefault = true;
  let projectId: string;
  let originalMode: "default" | "inherit" | "override" | "none" | undefined;

  const openAgents = async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
    await waitVisible('[data-testid="agent-customizations"]');
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    originalDefault = await browser.execute(async () => (await window.__termic!.ipc.settingsLoad()).customizations_enabled ?? true);
    const project = await browser.execute(() => window.__termic!.useApp.getState().projects.find((p: { id: string; name: string }) => p.name === "fixture-repo")!);
    projectId = project.id;
    originalMode = project.customization_mode;
    backup = mkdtempSync(path.join(path.dirname(dataDir), "customizations-backup-"));
    hadFolder = existsSync(folder);
    if (hadFolder) renameSync(folder, path.join(backup, "original"));
    originalLog = existsSync(openedLog) ? readFileSync(openedLog, "utf8") : null;
    await openAgents();
  });

  after(async () => {
    await browser.execute(async (enabled) => {
      await window.__termic!.ipc.customizationsSetEnabled(enabled);
      window.__termic!.useApp.getState().closeSettings();
    }, originalDefault);
    if (projectId) await browser.execute(async (id, mode) => {
      const app = window.__termic!.useApp.getState();
      const project = app.projects.find((p: { id: string; name: string }) => p.id === id)!;
      await window.__termic!.ipc.projectUpdate({ ...project, customization_mode: mode });
      await app.loadAll();
    }, projectId, originalMode ?? "default");
    rmSync(folder, { recursive: true, force: true });
    if (hadFolder) renameSync(path.join(backup, "original"), folder);
    if (backup) rmSync(backup, { recursive: true, force: true });
    if (originalLog === null) rmSync(openedLog, { force: true });
    else writeFileSync(openedLog, originalLog);
  });

  it("initializes the current profile folder on click and explains its layout", async () => {
    expect(existsSync(folder)).toBe(false);
    await clickWhenVisible('[data-testid="agent-customizations"] summary');
    expect(await textOf('[data-testid="customizations-layout"]')).toContain("skills/example/SKILL.md");
    await clickWhenVisible('[data-testid="customizations-open"]');
    await waitVisible('[data-testid="customizations-path"]');
    expect(await textOf('[data-testid="customizations-path"]')).toBe(folder);
    expect(existsSync(path.join(folder, "skills/termic/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(folder, "agents"))).toBe(true);
    expect(existsSync(path.join(folder, "mcp"))).toBe(true);
    expect(readFileSync(openedLog, "utf8").trimEnd().split("\n").at(-1)).toBe(folder);
    await snap("agent-customizations-open.png");
  });

  it("preserves edited skills when reopening the folder", async () => {
    const skill = path.join(folder, "skills/termic/SKILL.md");
    writeFileSync(skill, "# Synthetic user skill\n");
    await clickWhenVisible('[data-testid="customizations-open"]');
    await browser.waitUntil(async () => browser.execute(() => !(document.querySelector('[data-testid="customizations-open"]') as HTMLButtonElement).disabled));
    expect(readFileSync(skill, "utf8")).toBe("# Synthetic user skill\n");
  });

  it("persists the shared default across settings visits", async () => {
    const toggle = '[data-testid="customizations-default"] [role="switch"]';
    await browser.waitUntil(async () => browser.execute((sel) => !(document.querySelector(sel) as HTMLButtonElement).disabled, toggle));
    const before = await browser.execute((sel) => document.querySelector(sel)?.getAttribute("aria-checked"), toggle);
    await clickWhenVisible(toggle);
    await browser.waitUntil(async () => (await browser.execute((sel) => document.querySelector(sel)?.getAttribute("aria-checked"), toggle)) !== before);
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await waitGone('[data-testid="agent-customizations"]');
    await openAgents();
    await browser.waitUntil(async () => browser.execute((sel) => !(document.querySelector(sel) as HTMLButtonElement).disabled, toggle));
    expect(await browser.execute((sel) => document.querySelector(sel)?.getAttribute("aria-checked"), toggle)).toBe(before === "true" ? "false" : "true");
  });

  it("shows initialization errors and recovers on retry", async () => {
    const saved = path.join(backup, "retry");
    renameSync(folder, saved);
    writeFileSync(folder, "Synthetic obstruction");
    try {
      await clickWhenVisible('[data-testid="customizations-open"]');
      await waitVisible('[data-testid="customizations-error"]');
      expect(await textOf('[data-testid="customizations-error"]')).not.toBe("");
      await snap("agent-customizations-error.png");
    } finally {
      rmSync(folder, { force: true });
      renameSync(saved, folder);
    }
    await clickWhenVisible('[data-testid="customizations-open"]');
    await browser.waitUntil(async () => browser.execute(() =>
      !(document.querySelector('[data-testid="customizations-open"]') as HTMLButtonElement).disabled
        && !document.querySelector('[data-testid="customizations-error"]')));
    await waitVisible('[data-testid="customizations-path"]');
  });

  it("offers the profile default and retains an explicit project override", async () => {
    await browser.execute(async (id) => {
      const app = window.__termic!.useApp.getState();
      await window.__termic!.ipc.projectUpdate({ ...app.projects.find((p: { id: string; name: string }) => p.id === id)!, customization_mode: "default" });
      await app.loadAll();
      app.openSettings("repositories", id);
    }, projectId);
    await clickWhenVisible('[data-repo-tab="advanced"]');
    const select = '[data-testid="project-customizations-mode"]';
    await waitVisible(select);
    expect(await browser.execute((sel) => (document.querySelector(sel) as HTMLSelectElement).selectedOptions[0].textContent, select)).toBe("Use profile default");
    await browser.execute((sel) => {
      const control = document.querySelector(sel) as HTMLSelectElement;
      control.value = "inherit";
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }, select);
    await browser.waitUntil(async () => browser.execute(async (id) => (await window.__termic!.ipc.projectsList()).find((p: { id: string; name: string }) => p.id === id)?.customization_mode === "inherit", projectId));
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await browser.execute((id) => window.__termic!.useApp.getState().openSettings("repositories", id), projectId);
    await clickWhenVisible('[data-repo-tab="advanced"]');
    await waitVisible(select);
    expect(await browser.execute((sel) => (document.querySelector(sel) as HTMLSelectElement).value, select)).toBe("inherit");
  });
});
