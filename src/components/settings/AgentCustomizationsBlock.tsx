import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { customizationsOpen, customizationsSetEnabled, settingsLoad } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { Toggle } from "./Controls";

export function AgentCustomizationsBlock() {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const openPending = useRef(false);
  const savePending = useRef(false);

  useEffect(() => {
    settingsLoad()
      .then(s => { if (live.current) setEnabled(s.customizations_enabled ?? true); })
      .catch(e => { if (live.current) setError(String(e)); });
    return () => { live.current = false; };
  }, []);

  async function openFolder() {
    if (openPending.current) return;
    openPending.current = true;
    setOpening(true);
    setError(null);
    try {
      const opened = await customizationsOpen();
      if (live.current) setPath(opened);
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      openPending.current = false;
      if (live.current) setOpening(false);
    }
  }

  async function changeDefault(next: boolean) {
    if (savePending.current) return;
    savePending.current = true;
    setSaving(true);
    setError(null);
    try {
      await customizationsSetEnabled(next);
      if (live.current) setEnabled(next);
    } catch (e) {
      if (live.current) setError(String(e));
      const current = await settingsLoad().catch(() => null);
      if (live.current && current) setEnabled(current.customizations_enabled ?? true);
    } finally {
      savePending.current = false;
      if (live.current) setSaving(false);
    }
  }

  return (
    <section data-testid="agent-customizations" aria-labelledby="agent-customizations-title"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="agent-customizations-title" className="text-[14px] font-medium">{t("agents.customizations.title")}</h2>
        <Button size="sm" onClick={() => void openFolder()} disabled={opening}
          data-testid="customizations-open">
          <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
          {t(opening ? "agents.customizations.opening" : "agents.customizations.open")}
        </Button>
      </div>
      <p className="text-[13px] text-[var(--color-fg-dim)]">{t("agents.customizations.hint")}</p>
      <div data-testid="customizations-default">
        <Toggle label={t("agents.customizations.defaultLabel")} hint={t("agents.customizations.defaultHint")}
          value={enabled ?? true} disabled={enabled === null || saving} onChange={next => void changeDefault(next)} />
      </div>
      <details className="text-[12.5px] text-[var(--color-fg-dim)]">
        <summary className="cursor-pointer text-[var(--color-fg)]">{t("agents.customizations.layout")}</summary>
        <ul className="mt-2 space-y-1 list-disc pl-5" data-testid="customizations-layout">
          <li><Trans t={t} i18nKey="agents.customizations.skills" components={{ 1: <code className="font-mono" /> }} /></li>
          <li><Trans t={t} i18nKey="agents.customizations.personas" components={{ 1: <code className="font-mono" /> }} /></li>
          <li><Trans t={t} i18nKey="agents.customizations.mcp" components={{ 1: <code className="font-mono" /> }} /></li>
        </ul>
        <p className="mt-2"><Trans t={t} i18nKey="agents.customizations.secrets" components={{ 1: <code className="font-mono" /> }} /></p>
      </details>
      {path && <code data-testid="customizations-path" className="break-all text-[12px] text-[var(--color-fg-dim)]" aria-live="polite">{path}</code>}
      {error && <p data-testid="customizations-error" role="alert" className="text-[13px] text-[var(--color-err)]">{error}</p>}
    </section>
  );
}
