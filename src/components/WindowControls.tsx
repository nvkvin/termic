// Minimize / maximize / close for a window with no native title bar, which
// is Windows and Linux: the app's own top bar (UnifiedBar) is the title bar
// there, as it is on macOS, where the traffic lights are drawn by the system
// instead.
//
// Each platform gets its own look, on the same three full-height hit areas:
//
//   Windows  46px-wide buttons, the system's caption glyphs (Segoe Fluent
//            Icons on Windows 11, Segoe MDL2 Assets on 10, the same code
//            points), a neutral hover and the system red on Close.
//   Linux    GNOME's: a small round button per action, no red. The hit area
//            is still the whole height of the bar and reaches the window's
//            corner, so throwing the pointer at the top-right closes.
//
// Renders nothing on macOS.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { DRAWS_WINDOW_CONTROLS, IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Caption glyphs, as Windows draws them. */
const GLYPH = {
  minimize: "",
  maximize: "",
  restore: "",
  close: "",
} as const;

type Kind = "minimize" | "maximize" | "close";

export function WindowControls() {
  // Hooks run before the platform bail below, which is why the t() calls
  // sit there and not at the button call sites after it.
  const { t } = useTranslation("common");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!DRAWS_WINDOW_CONTROLS) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      win.isMaximized().then(m => { if (alive) setMaximized(m); }).catch(() => {});
    };
    sync();
    // A double click on the bar, Win+Up, or a snap all change it without a
    // click here, and they all resize the window.
    let unlisten: (() => void) | undefined;
    win.onResized(sync).then(u => { if (alive) unlisten = u; else u(); }).catch(() => {});
    return () => { alive = false; unlisten?.(); };
  }, []);

  if (!DRAWS_WINDOW_CONTROLS) return null;
  const win = getCurrentWindow();

  const windowsFace = (kind: Kind) =>
    kind === "minimize" ? GLYPH.minimize : kind === "close" ? GLYPH.close : maximized ? GLYPH.restore : GLYPH.maximize;

  const linuxFace = (kind: Kind) => {
    const Icon = kind === "minimize" ? Minus : kind === "close" ? X : maximized ? Copy : Square;
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-bg-3)] transition-colors group-hover:bg-[var(--color-border)] group-hover:text-[var(--color-fg)] group-focus-visible:bg-[var(--color-border)]">
        {/* The square reads larger than the two strokes at the same size. */}
        <Icon size={kind === "maximize" ? 10 : 13} strokeWidth={2} aria-hidden />
      </span>
    );
  };

  const button = (kind: Kind, label: string, onClick: () => void) => (
    <button
      type="button"
      data-no-drag
      data-testid={`window-${kind}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "group flex h-full items-center justify-center text-[var(--color-fg-dim)] outline-none",
        IS_WINDOWS
          ? cn(
              "w-[46px] text-[10px] transition-colors",
              kind === "close"
                ? "hover:bg-[var(--color-caption-close)] hover:text-[var(--color-caption-close-fg)] focus-visible:bg-[var(--color-caption-close)] focus-visible:text-[var(--color-caption-close-fg)]"
                : "hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] focus-visible:bg-[var(--color-bg-3)]",
            )
          // The last button is wider on its outer side only, so the circles
          // stay evenly spaced while the hit area runs to the window's edge.
          : kind === "close" ? "w-[42px] pr-2" : "w-[34px]",
      )}
      style={IS_WINDOWS ? { fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"' } : undefined}
    >
      {IS_WINDOWS ? windowsFace(kind) : linuxFace(kind)}
    </button>
  );

  return (
    <div
      data-testid="window-controls"
      data-maximized={maximized ? "true" : "false"}
      className="flex h-full shrink-0 items-stretch self-stretch"
    >
      {button("minimize", t("minimize"), () => { win.minimize().catch(() => {}); })}
      {button("maximize", maximized ? t("restore") : t("maximize"), () => { win.toggleMaximize().catch(() => {}); })}
      {button("close", t("close"), () => { win.close().catch(() => {}); })}
    </div>
  );
}
