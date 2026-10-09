// The resize cursor on the edges of the Linux window, which has no native
// frame (see WindowControls).
//
// The window already RESIZES from its edges: tao hit-tests the outer 5px of
// an undecorated GTK window and starts the resize itself. What it cannot do
// is show it: it sets the resize cursor on the toplevel window
// (event_loop.rs, connect_motion_notify_event), and over the webview, which
// covers all of that window, the pointer stayed whatever the page's CSS
// asked for. So the edge resized and the pointer never said so. (Observed;
// the likely reason is that the webview is its own GDK window with its own
// cursor, but that part was not isolated.)
//
// These strips are that missing cursor: eight transparent elements over the
// same 5px, each with the CSS cursor for its edge. The mousedown is belt and
// braces for a press that reaches the page before GTK acts on it.
//
// Windows needs none of this (its frameless window keeps the system's resize
// border, outside the webview), and macOS has a real frame.

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_LINUX } from "@/lib/platform";

type Direction = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

/** tao's own inset (`scale_factor * 5` in its motion handler). */
const EDGE = 5;
/** Corners reach further along each edge, as every window manager's do. */
const CORNER = 12;

const STRIPS: ReadonlyArray<{ dir: Direction; cursor: string; style: React.CSSProperties }> = [
  { dir: "North", cursor: "ns-resize", style: { top: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: "South", cursor: "ns-resize", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: "West", cursor: "ew-resize", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: "East", cursor: "ew-resize", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: "NorthWest", cursor: "nwse-resize", style: { top: 0, left: 0, width: CORNER, height: EDGE } },
  { dir: "NorthWest", cursor: "nwse-resize", style: { top: 0, left: 0, width: EDGE, height: CORNER } },
  { dir: "NorthEast", cursor: "nesw-resize", style: { top: 0, right: 0, width: CORNER, height: EDGE } },
  { dir: "NorthEast", cursor: "nesw-resize", style: { top: 0, right: 0, width: EDGE, height: CORNER } },
  { dir: "SouthWest", cursor: "nesw-resize", style: { bottom: 0, left: 0, width: CORNER, height: EDGE } },
  { dir: "SouthWest", cursor: "nesw-resize", style: { bottom: 0, left: 0, width: EDGE, height: CORNER } },
  { dir: "SouthEast", cursor: "nwse-resize", style: { bottom: 0, right: 0, width: CORNER, height: EDGE } },
  { dir: "SouthEast", cursor: "nwse-resize", style: { bottom: 0, right: 0, width: EDGE, height: CORNER } },
];

export function WindowResizeEdges() {
  // A maximized or full-screen window does not resize from its edges, and a
  // resize cursor along the screen's edge would say it does.
  const [fixed, setFixed] = useState(false);

  useEffect(() => {
    if (!IS_LINUX) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      Promise.all([win.isMaximized(), win.isFullscreen()])
        .then(([m, f]) => { if (alive) setFixed(m || f); })
        .catch(() => {});
    };
    sync();
    let unlisten: (() => void) | undefined;
    win.onResized(sync).then(u => { if (alive) unlisten = u; else u(); }).catch(() => {});
    return () => { alive = false; unlisten?.(); };
  }, []);

  if (!IS_LINUX || fixed) return null;

  return (
    <div data-testid="window-resize-edges" aria-hidden>
      {STRIPS.map((s, i) => (
        <div
          key={i}
          data-no-drag
          data-resize-edge={s.dir}
          className="fixed z-[9999]"
          style={{ ...s.style, cursor: s.cursor }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            getCurrentWindow().startResizeDragging(s.dir).catch(() => {});
          }}
        />
      ))}
    </div>
  );
}
