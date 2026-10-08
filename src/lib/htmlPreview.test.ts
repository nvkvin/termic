import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  openExternalUrl: vi.fn(async () => ({ used: "default", reason: null })),
}));

import { hasRemoteImages, htmlPreviewCsp, htmlPreviewSrcdoc, isHtmlPath, openHtmlInBrowser } from "@/lib/htmlPreview";
import { openExternalUrl } from "@/lib/ipc";

describe("isHtmlPath", () => {
  it("matches .html and .htm in any case, at any depth", () => {
    expect(isHtmlPath("report.html")).toBe(true);
    expect(isHtmlPath("out/Coverage/index.HTM")).toBe(true);
    expect(isHtmlPath("docs/a.b.Html")).toBe(true);
  });

  it("rejects other extensions, extension-less names and directories named html", () => {
    expect(isHtmlPath("page.xhtml")).toBe(false);
    expect(isHtmlPath("page.html.bak")).toBe(false);
    expect(isHtmlPath("html")).toBe(false);
    expect(isHtmlPath(".html")).toBe(false);
    expect(isHtmlPath("site/html/logo.svg")).toBe(false);
  });
});

/** The directives of a policy string, by name. */
function directives(csp: string): Record<string, string> {
  return Object.fromEntries(csp.split(";").map((d) => {
    const [name, ...rest] = d.trim().split(/\s+/);
    return [name, rest.join(" ")];
  }));
}

describe("htmlPreviewCsp", () => {
  it("blocks everything but inline style and data: by default", () => {
    const d = directives(htmlPreviewCsp(false));
    expect(d["default-src"]).toBe("'none'");
    expect(d["style-src"]).toBe("'unsafe-inline'");
    expect(d["img-src"]).toBe("data:");
    // No script source at all: default-src 'none' is what applies, and the
    // inherited app policy blocks inline script independently.
    expect(d["script-src"]).toBeUndefined();
  });

  it("adds https: to img-src, and ONLY there, when remote images are unblocked", () => {
    const off = directives(htmlPreviewCsp(false));
    const on = directives(htmlPreviewCsp(true));
    expect(on["img-src"]).toBe("data: https:");
    for (const k of Object.keys(off)) {
      if (k !== "img-src") expect(on[k]).toBe(off[k]);
    }
    expect(htmlPreviewCsp(true)).not.toContain("http:");
  });
});

describe("htmlPreviewSrcdoc", () => {
  it("puts the policy meta before anything the document says, doctype included", () => {
    const src = htmlPreviewSrcdoc("<!DOCTYPE html><html><head></head><body>hi</body></html>", false);
    // First token, so it always lands in <head> (a CSP meta in <body> is ignored).
    expect(src.startsWith('<meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    expect(src.indexOf("<base href=\"about:srcdoc\">")).toBeLessThan(src.indexOf("<!DOCTYPE"));
    expect(src.endsWith("<body>hi</body></html>")).toBe(true);
  });

  it("keeps a document's own <base> second, so ours is the one that applies", () => {
    const src = htmlPreviewSrcdoc('<base href="https://example.com/"><img src="a.png">', false);
    expect(src.indexOf('<base href="about:srcdoc">')).toBeLessThan(src.indexOf('<base href="https://example.com/">'));
  });

  it("carries the remote toggle into the policy", () => {
    expect(htmlPreviewSrcdoc("", false)).toContain('content="' + htmlPreviewCsp(false) + '"');
    expect(htmlPreviewSrcdoc("", true)).toContain('content="' + htmlPreviewCsp(true) + '"');
  });

  it("passes the document through untouched, scripts and all", () => {
    // Not a sanitizer: the iframe sandbox and the CSP are the boundary, and
    // rewriting the markup would change what the author wrote.
    const doc = "<script>alert(1)</script><style>p{color:red}</style>";
    expect(htmlPreviewSrcdoc(doc, false).endsWith(doc)).toBe(true);
  });
});

describe("hasRemoteImages", () => {
  it("finds https images in src, srcset and CSS url()", () => {
    expect(hasRemoteImages('<img src="https://example.com/a.png">')).toBe(true);
    expect(hasRemoteImages("<img src=https://example.com/a.png>")).toBe(true);
    expect(hasRemoteImages('<img SRC = \'HTTPS://example.com/a.png\'>')).toBe(true);
    expect(hasRemoteImages('<img srcset="https://example.com/a.png 2x">')).toBe(true);
    expect(hasRemoteImages("<style>.x{background:url( 'https://example.com/a.png')}</style>")).toBe(true);
    expect(hasRemoteImages('<div style="background-image:url(https://example.com/a.png)">')).toBe(true);
  });

  it("ignores links, data: and relative images, and http: the app blocks anyway", () => {
    expect(hasRemoteImages('<a href="https://example.com/">docs</a>')).toBe(false);
    expect(hasRemoteImages('<img src="data:image/png;base64,AAAA">')).toBe(false);
    expect(hasRemoteImages('<img src="chart.png">')).toBe(false);
    expect(hasRemoteImages('<img src="http://example.com/a.png">')).toBe(false);
  });
});

describe("openHtmlInBrowser", () => {
  it("resolves an in-task HTML file to a file:// URI and opens it", async () => {
    vi.mocked(openExternalUrl).mockClear();
    const task = { path: "/Users/alice/project", project_id: "p1" };
    await openHtmlInBrowser(task, "reports/index.html");
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openExternalUrl).mock.calls[0][0]).toBe("file:///Users/alice/project/reports/index.html");
  });

  it("resolves an external HTML file using the absolute path directly", async () => {
    vi.mocked(openExternalUrl).mockClear();
    const task = { path: "/Users/alice/project", project_id: "p1" };
    await openHtmlInBrowser(task, "/tmp/artifacts/report.html", true);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openExternalUrl).mock.calls[0][0]).toBe("file:///tmp/artifacts/report.html");
  });
});
