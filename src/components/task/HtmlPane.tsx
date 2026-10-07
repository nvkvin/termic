// Wrapper for HTML edit tabs: the same source / split / preview shell
// markdown and SVG use (SourcePreviewShell), over the CodeMirror editor and
// the document rendered in a sandboxed iframe. Agents write their reports as
// self-contained HTML (inline <style>, inline SVG, tables), and before this
// the only way to read one rendered was to leave the app.
//
// SECURITY. The document is untrusted (an agent's report, a page inside a
// dependency, a file a prompt-injected agent wrote on purpose) and this
// webview can call every Tauri command, so it must never run script in the
// app's origin. The iframe is the boundary, NOT a sanitizer:
//
//   * `sandbox=""` gives the document an opaque origin with no scripts,
//     forms, popups or top-level navigation, and no reach into this one.
//     Measured: WITHOUT the attribute a srcdoc frame shares the app's origin
//     and its globals, __TAURI_INTERNALS__ included. Never add
//     allow-same-origin, and do not add allow-scripts without reading
//     docs/sandbox.md ("HTML preview") first.
//   * A srcdoc document inherits the app's CSP, so `script-src 'self'`
//     blocks every inline and external script a second time, independently.
//   * lib/htmlPreview narrows what the inherited policy still allows
//     (remote images, fetches against the app's own origin).
//
// So a report's JavaScript does not run: a Chart.js chart renders blank, an
// inline SVG one renders. Links do nothing except in-page `#anchors`.
//
// No tabIndex on the iframe. SourcePreviewShell focuses the first
// [tabindex] in a preview-only pane, and focus inside a cross-origin frame
// takes every shortcut with it: they are keydown listeners on THIS window,
// and key events do not cross a frame boundary. The wrapper is the target.
//
// The preview renders the editor's LIVE buffer, like SvgPane, so there is no
// IPC read here and split view updates as you type. A new srcdoc is a new
// document, so the frame's scroll resets on every change; hidden tabs keep
// theirs (display:none does not unload a frame, measured).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";
import { Check, ImageOff } from "lucide-react";
import type { EditTab, ExternalTab, Task } from "@/lib/types";
import { hasRemoteImages, htmlPreviewSrcdoc } from "@/lib/htmlPreview";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { EditorPane } from "./EditorPane";
import { SourcePreviewShell, type SourceView } from "./SourcePreviewShell";
import { TerminalExitedBanner } from "./TerminalExitedBanner";

export function HtmlPane(
  { task, tab, active = false }: {
    task: Task;
    /** A `.html` / `.htm` file in the task, or an EXTERNAL one (an absolute
     *  path outside it, read-only). Nothing here reads the file, so both
     *  work the same way: the editor loads it, the preview renders the
     *  buffer. */
    tab: EditTab | ExternalTab;
    active?: boolean;
  },
) {
  const { t } = useTranslation("panels");
  // Per-tab override + its own persisted default, like SVG: a report is
  // something you open to read, whatever the markdown default says.
  const defaultView = usePrefs(s => s.htmlDefaultView);
  const view: SourceView = tab.mdView ?? defaultView;
  const setView = (v: SourceView) => {
    useApp.getState().patchTab(task.id, tab.id, { mdView: v });
    usePrefs.getState().setHtmlDefaultView(v);
  };

  // The markdown preview's remote-image gate (#69), same pref and same
  // per-tab override: one setting answers "may a preview fetch remote
  // images", whichever kind of document asked.
  const loadRemoteImages = usePrefs(s => s.loadRemoteImages);
  const remoteImages = tab.remoteImagesUnblocked ?? loadRemoteImages;
  const [justAllowedGlobally, setJustAllowedGlobally] = useState(false);
  useEffect(() => {
    if (!justAllowedGlobally) return;
    const id = window.setTimeout(() => setJustAllowedGlobally(false), 5000);
    return () => window.clearTimeout(id);
  }, [justAllowedGlobally]);

  // Live buffer from the editor's onContent, debounced and labelled with the
  // path it was read for; SvgPane explains both. Null until the first read
  // lands, which is what tells an EMPTY file (a blank page) apart from a read
  // that never arrived.
  const [buf, setBuf] = useState<{ path: string; text: string } | null>(null);
  const text = buf && buf.path === tab.path ? buf.text : null;
  const debounceRef = useRef<number | null>(null);
  function onContent(v: EditorView) {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    const path = tab.path;
    debounceRef.current = window.setTimeout(() => setBuf({ path, text: v.state.doc.toString() }), 200);
  }
  useEffect(() => () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); }, [tab.path]);

  const srcdoc = useMemo(() => (text == null ? null : htmlPreviewSrcdoc(text, remoteImages)), [text, remoteImages]);
  const blocked = useMemo(() => !remoteImages && text != null && hasRemoteImages(text), [remoteImages, text]);

  // EditorPane calls onContent ON LOAD, so nothing after this long means the
  // read failed (task_file_read's 2 MB cap, or not UTF-8). The editor names
  // the reason; the preview says it has nothing rather than "Loading…"
  // forever.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (text != null) { setStalled(false); return; }
    const id = window.setTimeout(() => setStalled(true), 1500);
    return () => window.clearTimeout(id);
  }, [text, tab.path]);

  return (
    <SourcePreviewShell
      view={view}
      setView={setView}
      active={active}
      editor={<EditorPane task={task} tab={tab} onContent={onContent} active={active && view !== "preview"} />}
      preview={() => (
        <div tabIndex={-1} className="flex h-full flex-col bg-[var(--color-bg)] outline-none">
          {blocked && (
            <TerminalExitedBanner
              label={t("mdPreview.imagesBlocked")}
              actionLabel={t("mdPreview.showImages")}
              onAction={() => useApp.getState().patchTab(task.id, tab.id, { remoteImagesUnblocked: true })}
              icon={ImageOff}
              tone="muted"
              center
              secondary={{
                label: t("mdPreview.always"),
                onAction: () => {
                  usePrefs.getState().setLoadRemoteImages(true);
                  setJustAllowedGlobally(true);
                },
              }}
            />
          )}
          {!blocked && justAllowedGlobally && (
            <TerminalExitedBanner
              label={t("mdPreview.imagesNowLoad")}
              actionLabel={t("mdPreview.settings")}
              onAction={() => useApp.getState().openSettings("general", undefined, "load-remote-images")}
              icon={Check}
              tone="muted"
              center
            />
          )}
          {srcdoc != null
            ? (
              <iframe
                data-testid="html-preview"
                title={tab.title}
                sandbox=""
                srcDoc={srcdoc}
                className="min-h-0 w-full flex-1 border-0 bg-[var(--color-html-canvas)]"
              />
            )
            : (
              <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">
                {stalled ? t("htmlPane.unavailable") : t("shared.loading")}
              </div>
            )}
        </div>
      )}
    />
  );
}
