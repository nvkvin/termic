// Clipboard helpers. One place so every "copy" affordance gives the same
// toast feedback and failure handling instead of each call site re-deriving
// the writeText(...).then().catch() boilerplate.

import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { i18n } from "@/lib/i18n";
import { useUI } from "@/store/ui";

/** Copy arbitrary text, with a confirmation / failure toast. `label` is the
 *  human noun for the toast, e.g. "path" → `Copied path`.
 *
 *  Writes via the Rust clipboard plugin, NOT navigator.clipboard: WKWebView
 *  gates the web API on transient user activation + document focus, and a
 *  Radix menu's onSelect fires from a synthetic event that carries neither —
 *  every context-menu copy rejected with NotAllowedError. The plugin talks
 *  to NSPasteboard directly and has no gesture requirement; the web API is
 *  kept only as a fallback should the IPC ever fail. */
export function copyToClipboard(text: string, label = "text") {
  return writeClipboardText(text)
    .then(() => useUI.getState().pushToast(i18n.t("backend:clipboard.copied", { label }), "success"))
    .catch(() => useUI.getState().pushToast(i18n.t("backend:clipboard.failed"), "error"));
}

/** Read the clipboard as text.
 *
 *  Through the Rust plugin, for the same reason as the write above and one
 *  more: WebKitGTK refuses `navigator.clipboard.readText()` outright.
 *  Measured on Linux with a real key press as the gesture: NotAllowedError,
 *  every time, so Ctrl+Shift+V pasted nothing into a terminal there.
 *  The web API stays as the fallback. */
export function readClipboardText(): Promise<string> {
  return readText().catch(() => navigator.clipboard.readText());
}

/** Write text to the clipboard with no toast: the plain form of
 *  `copyToClipboard`, for call sites that show their own confirmation.
 *  Plugin first, so it also works where there is no user gesture to spend
 *  (copy-on-select runs from a timer). */
export function writeClipboardText(text: string): Promise<void> {
  return writeText(text).catch(() => navigator.clipboard.writeText(text));
}
