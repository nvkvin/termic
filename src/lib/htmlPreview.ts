// The security-relevant half of the HTML preview (HtmlPane), kept apart from
// the component so the exact string the iframe receives is unit-testable.
//
// The boundary is the iframe, not this file: HtmlPane renders the document in
// `<iframe sandbox="" srcdoc>`, which gives it an opaque origin with no
// scripts, forms, popups or top-level navigation, and the app's CSP is
// inherited by every srcdoc document, so `script-src 'self'` blocks script a
// second time. Measured in WKWebView, with controls, in docs/sandbox.md
// ("HTML preview"). What this file adds is narrowing ON TOP of that: the
// inherited policy still allows `img-src https:`, which is egress (the same
// hole #65 closed for markdown), and relative URLs that resolve against
// tauri://localhost.

/** `.html` / `.htm`, case-insensitive. Purely a routing question for TaskView,
 *  like `isSvgPath`. */
export function isHtmlPath(path: string): boolean {
  const base = path.split("/").pop() || path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return ext === "html" || ext === "htm";
}

/** The policy every previewed document runs under, intersected with the app's
 *  own (a `<meta>` policy can only narrow an inherited one, never widen it).
 *  `default-src 'none'` covers fetches the app policy would allow from its own
 *  origin; `https:` is added to `img-src` only when remote images are
 *  unblocked, mirroring the markdown preview's gate. */
export function htmlPreviewCsp(remoteImages: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    remoteImages ? "img-src data: https:" : "img-src data:",
    "font-src data:",
    "media-src data:",
  ].join("; ");
}

/** The srcdoc for a document: the narrowing prefix, then the file verbatim.
 *
 *  The prefix is PREPENDED as raw text on purpose. WebKit ignores a CSP
 *  `<meta>` that lands in `<body>`, and anything that implicitly opens the body
 *  (an `<img>` in `<head>`, stray text) would put one written "into the head"
 *  there. As the very first tokens these always land in the head, and no later
 *  markup can undo them: a report's own CSP meta only narrows further, and the
 *  FIRST `<base href>` wins. The cost is that the parser drops the report's
 *  `<!DOCTYPE>`, which is nothing here because a srcdoc document is always in
 *  standards mode.
 *
 *  `<base href="about:srcdoc">` because a srcdoc document otherwise takes the
 *  PARENT's base URL: `#section` links would point at tauri://localhost/ and be
 *  blocked (so a report's table of contents did nothing), and `chart.png`
 *  would be fetched from the app's own bundle. With this base, fragment links
 *  scroll within the document and relative URLs fetch nothing. */
export function htmlPreviewSrcdoc(text: string, remoteImages: boolean): string {
  return `<meta http-equiv="Content-Security-Policy" content="${htmlPreviewCsp(remoteImages)}">`
    + `<meta name="referrer" content="no-referrer">`
    + `<base href="about:srcdoc">`
    + text;
}

/** Does the document reference a remote (https) image the narrowed policy
 *  blocks? Drives the "images blocked" banner, nothing else: a false positive
 *  (an https URL quoted inside a <pre>) costs a banner, never a fetch. `http:`
 *  is not matched because the app's own CSP blocks it whatever the toggle says,
 *  so offering to unblock it would offer a button that does nothing. */
export function hasRemoteImages(text: string): boolean {
  return /(?:\bsrc(?:set)?\s*=\s*["']?|\burl\(\s*["']?)\s*https:\/\//i.test(text);
}

/** Open an HTML file in the user's configured browser (or OS default). */
export { openFileInBrowser as openHtmlInBrowser } from "@/lib/previewBrowser";
