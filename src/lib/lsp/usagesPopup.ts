// "Who uses this?", answered next to the thing you asked about (GH #174).
//
// `@codemirror/lsp-client` ships a reference PANEL, docked under the editor.
// That is the wrong shape for reading: your eye is on a symbol at line 347 and
// the answer appears at the bottom of the window, so every lookup costs a
// glance across the whole pane and back. JetBrains floats it at the symbol,
// which is why the gesture feels like inspecting rather than navigating.
//
// So this is a CodeMirror tooltip anchored at the clicked position — the same
// surface inline blame's commit card uses — with the rows grouped by file,
// keyboard-navigable, and click-to-jump.

import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { currentPoint, navigateTo, pointFor, taskForPath } from "./navigate";

export interface UsageRow {
  uri: string;
  /** Display name: relative to the checkout where possible. */
  file: string;
  /** 1-based. */
  line: number;
  /** The line's own text, trimmed for display. */
  text: string;
  /** Absolute path, for the footer that says which file this really is. */
  path: string;
  /** Column range of the match within the line, for the bold run. */
  from: number;
  to: number;
}

/** Show these usages at `pos`, or close the popup when the payload is null.
 *  `symbol` is what was clicked, which is what the header names. */
export const setUsages = StateEffect.define<
  { pos: number; symbol: string; symbolOffset: number; rows: UsageRow[] } | null
>();

/** Rows are capped: a symbol with 400 usages is a list nobody reads in a
 *  popup, and the count still tells the truth about how many there are. */
export const MAX_ROWS = 60;

/** The popup's size once someone has dragged its corner. Remembered across
 *  popups (and restarts, per viewer) because the list that was too small for
 *  one symbol is too small for the next: a 26-character file column reads the
 *  same way every time. Null until the first drag, which keeps the natural,
 *  content-fitted size for people who never resize it. */
export interface UsagesSize { width: number; height: number }

export const USAGES_MIN_WIDTH = 320;
export const USAGES_MIN_HEIGHT = 120;
/** Gap kept between a dragged edge and the window edge. */
const VIEWPORT_MARGIN = 8;
const LS_USAGES_SIZE = "usagesPopupSize";

/** Clamp a requested size to the minimum and to the room between the popup's
 *  top-left corner and the window's bottom-right. The corner is what stays
 *  put during a drag, so that room is the only room there is. */
export function clampUsagesSize(
  want: UsagesSize,
  room: UsagesSize,
): UsagesSize {
  const clamp = (v: number, min: number, max: number) =>
    Math.round(Math.max(min, Math.min(Math.max(min, max), v)));
  return {
    width: clamp(want.width, USAGES_MIN_WIDTH, room.width),
    height: clamp(want.height, USAGES_MIN_HEIGHT, room.height),
  };
}

let savedSize: UsagesSize | null | undefined;

function readSavedSize(): UsagesSize | null {
  if (savedSize !== undefined) return savedSize;
  savedSize = null;
  try {
    const raw = JSON.parse(localStorage.getItem(LS_USAGES_SIZE) ?? "null");
    if (raw && Number.isFinite(raw.width) && Number.isFinite(raw.height)) {
      savedSize = { width: raw.width, height: raw.height };
    }
  } catch { /* no storage, or junk in it: natural size */ }
  return savedSize;
}

function writeSavedSize(size: UsagesSize): void {
  savedSize = size;
  try { localStorage.setItem(LS_USAGES_SIZE, JSON.stringify(size)); } catch { /* per-session only */ }
}

interface UsagesState {
  pos: number;
  symbol: string;
  /** How far `pos` sits into the symbol, so the mark covers the whole word
   *  rather than starting wherever the click landed. */
  symbolOffset: number;
  rows: UsageRow[];
  total: number;
  active: number;
}

const usagesField = StateField.define<UsagesState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setUsages)) {
        if (!e.value) return null;
        return {
          pos: e.value.pos,
          symbol: e.value.symbol,
          symbolOffset: e.value.symbolOffset,
          rows: e.value.rows.slice(0, MAX_ROWS),
          total: e.value.rows.length,
          active: 0,
        };
      }
      if (e.is(moveActive) && value) {
        const next = Math.max(0, Math.min(value.rows.length - 1, value.active + e.value));
        return next === value.active ? value : { ...value, active: next };
      }
    }
    // An edit invalidates the anchor and the answers alike.
    if (tr.docChanged && value) return null;
    return value;
  },
  provide: f => showTooltip.from(f, state => (state ? buildTooltip(state) : null)),
});

const moveActive = StateEffect.define<number>();

function buildTooltip(state: UsagesState): Tooltip {
  return {
    // The START of the symbol, not the character that was clicked. CodeMirror
    // anchors a tooltip's left edge at `pos`, so anchoring at the click put
    // the panel wherever in the word the pointer happened to land: click the
    // tail of `updateConfigFromServer` and the whole list starts 20 characters
    // to the right of the thing it is about. `symbolOffset` is how far into
    // the word the click was, and the highlight mark below already uses it for
    // exactly this reason.
    pos: Math.max(0, state.pos - state.symbolOffset),
    above: false,
    // Not arrow-less by accident: the arrow is what ties the list to the
    // symbol it is about, which is the whole reason it floats here.
    arrow: true,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "cm-lsp-usages";

      // Header: what you asked about, and how many answers there are. Same
      // two facts IntelliJ leads with, and the count is the one that decides
      // whether you read the list or narrow the question.
      const head = dom.appendChild(document.createElement("div"));
      head.className = "cm-lsp-usages-head";
      const name = head.appendChild(document.createElement("span"));
      name.className = "cm-lsp-usages-symbol";
      name.textContent = state.symbol;
      const count = head.appendChild(document.createElement("span"));
      count.className = "cm-lsp-usages-count";
      // Zero is an ANSWER, and the one people most need. ⌘-clicking a
      // definition asks "who calls this"; nothing at all on screen reads as a
      // broken feature, while "No usages" is a fact worth knowing about the
      // function you were about to change.
      count.textContent = state.total === 0
        ? "No usages"
        : state.total === 1
          ? "1 usage"
          : state.total > state.rows.length
            ? `${state.rows.length} of ${state.total} usages`
            : `${state.total} usages`;

      if (!state.rows.length) {
        // Header only: no empty scroll box, no footer path, nothing to
        // arrow through. The one line IS the answer.
        return { dom };
      }

      const list = dom.appendChild(document.createElement("div"));
      list.className = "cm-lsp-usages-list";

      // The full path of whatever is selected, like IntelliJ's footer: the row
      // itself shows a short name, and this says which one it actually is when
      // three files share it.
      const footer = dom.appendChild(document.createElement("div"));
      footer.className = "cm-lsp-usages-footer";

      // Resizable from the bottom-right corner, the one corner that moves
      // nothing else: the tooltip is anchored by its top-left, so the header
      // and the arrow stay on the symbol while the list grows toward the
      // reader. A drawn grip rather than CSS `resize`, whose native handle is
      // a few pixels wide and cannot say where the size went.
      const saved = readSavedSize();
      if (saved) applySize(dom, saved, false);
      const grip = dom.appendChild(document.createElement("div"));
      grip.className = "cm-lsp-usages-grip";
      // Mouse events on window, like the app's other resize handles: the move
      // keeps tracking when the pointer outruns the grip, and the e2e drag
      // helper drives exactly this shape.
      grip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        // Keep the editor's focus (and so the keyboard navigation) where it
        // is, and keep the editor from starting a selection under the list.
        e.preventDefault();
        e.stopPropagation();
        const start = dom.getBoundingClientRect();
        const room = {
          width: window.innerWidth - start.left - VIEWPORT_MARGIN,
          height: window.innerHeight - start.top - VIEWPORT_MARGIN,
        };
        const x0 = e.clientX;
        const y0 = e.clientY;
        let last: UsagesSize = { width: start.width, height: start.height };
        dom.classList.add("cm-lsp-usages-resizing");
        const move = (ev: MouseEvent) => {
          last = clampUsagesSize(
            { width: start.width + ev.clientX - x0, height: start.height + ev.clientY - y0 },
            room,
          );
          applySize(dom, last, true);
        };
        const end = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", end);
          dom.classList.remove("cm-lsp-usages-resizing");
          writeSavedSize(last);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", end);
      });

      const rowEls: HTMLElement[] = [];
      const select = (i: number) => {
        rowEls.forEach((el, j) => el.classList.toggle("cm-lsp-usages-active", i === j));
        footer.textContent = state.rows[i]?.path ?? "";
        footer.title = footer.textContent;
        rowEls[i]?.scrollIntoView({ block: "nearest" });
      };

      state.rows.forEach((row, i) => {
        const entry = list.appendChild(document.createElement("div"));
        entry.className = "cm-lsp-usages-row";
        entry.dataset.index = String(i);
        // The label is short by design and the footer ellipsizes a deep path
        // from the right, so the full path has to be reachable somewhere.
        entry.title = `${row.path}:${row.line}`;

        // file · line · the code, with the match in bold. One row per usage
        // rather than a file header above a group: a symbol's usages are read
        // as one list, and repeating the file keeps every row self-contained.
        // The same file-type icon the breadcrumb and the tree use, so a row
        // here reads as the same object it does everywhere else in the app.
        const icon = entry.appendChild(document.createElement("img"));
        icon.className = "cm-lsp-usages-icon file-icon";
        icon.src = fileIconUrl(row.file.split("/").pop() ?? row.file);
        icon.alt = "";
        const file = entry.appendChild(document.createElement("span"));
        file.className = "cm-lsp-usages-file";
        file.textContent = row.file;
        const num = entry.appendChild(document.createElement("span"));
        num.className = "cm-lsp-usages-line";
        num.textContent = String(row.line);
        const code = entry.appendChild(document.createElement("span"));
        code.className = "cm-lsp-usages-code";
        const before = row.text.slice(0, row.from);
        const match = row.text.slice(row.from, row.to);
        const after = row.text.slice(row.to);
        if (before) code.appendChild(document.createTextNode(before));
        if (match) code.appendChild(document.createElement("strong")).textContent = match;
        if (after) code.appendChild(document.createTextNode(after));

        entry.addEventListener("mouseenter", () => select(i));
        entry.addEventListener("mousedown", (e) => {
          e.preventDefault();
          void jumpTo(view, row);
        });
        rowEls.push(entry);
      });
      select(state.active);
      return {
        dom,
        class: "cm-lsp-usages-tooltip",
        // Keep the highlight and the footer in step with keyboard movement.
        update: (update) => {
          const next = update.state.field(usagesField, false);
          if (next && next.pos === state.pos) select(next.active);
        },
      };
    },
  };
}

/** Size the popup. Width is always fixed. Height is fixed only while the
 *  corner is being dragged, so the box follows the pointer; a popup opened at
 *  a remembered size takes it as a CAP, so three usages do not sit in a box
 *  sized for forty. */
function applySize(dom: HTMLElement, size: UsagesSize, dragging: boolean): void {
  dom.style.width = `${size.width}px`;
  dom.style.maxWidth = "none";
  dom.style.height = dragging ? `${size.height}px` : "";
  dom.style.maxHeight = `${size.height}px`;
}

/** Open a usage. Same path as go-to-definition: the workspace decides which
 *  tab a file belongs in (an external one when it is outside the checkout). */
async function jumpTo(view: EditorView, row: UsageRow): Promise<void> {
  view.dispatch({ effects: setUsages.of(null) });
  const task = taskForPath(row.path);
  if (!task) return;
  // Same path as go-to-definition, which is also what records the trail: a
  // usage you opened is a place you want Back to return you from.
  await navigateTo(
    view,
    pointFor(task.id, task.path, row.path, row.line, row.from + 1),
    currentPoint(view),
  );
}

/** Keyboard: move, open, dismiss. Registered high so Escape closes the popup
 *  before anything else claims it. */
const usagesKeymap = EditorView.domEventHandlers({
  keydown(event, view) {
    const state = view.state.field(usagesField, false);
    if (!state) return false;
    if (event.key === "Escape") {
      view.dispatch({ effects: setUsages.of(null) });
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      view.dispatch({ effects: moveActive.of(event.key === "ArrowDown" ? 1 : -1) });
      return true;
    }
    if (event.key === "Enter") {
      const row = state.rows[state.active];
      if (row) void jumpTo(view, row);
      return true;
    }
    return false;
  },
});

/** While the list is open, the symbol it is about stays marked in the code,
 *  the way IntelliJ underlines it: the popup floats over the file, and without
 *  this there is nothing tying the answer to the question. */
const symbolMark = Decoration.mark({ class: "cm-lsp-usages-symbol-mark" });
const symbolHighlight = EditorView.decorations.compute([usagesField], state => {
  const s = state.field(usagesField, false);
  if (!s || !s.symbol) return Decoration.none;
  const from = Math.max(0, s.pos - s.symbolOffset);
  const to = Math.min(state.doc.length, from + s.symbol.length);
  return to > from ? Decoration.set([symbolMark.range(from, to)]) : Decoration.none;
});

const usagesTheme = EditorView.theme({
  ".cm-tooltip.cm-lsp-usages-tooltip": {
    backgroundColor: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
    color: "var(--color-fg)",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
  },
  ".cm-tooltip.cm-lsp-usages-tooltip.cm-tooltip-arrow:before": {
    borderBottomColor: "var(--color-border)",
    borderTopColor: "var(--color-border)",
  },
  ".cm-tooltip.cm-lsp-usages-tooltip.cm-tooltip-arrow:after": {
    borderBottomColor: "var(--color-bg)",
    borderTopColor: "var(--color-bg)",
  },
  ".cm-lsp-usages": {
    display: "flex",
    flexDirection: "column",
    maxHeight: "400px",
    maxWidth: "720px",
    overflow: "hidden",
    borderRadius: "6px",
    position: "relative",
  },
  ".cm-lsp-usages-grip": {
    position: "absolute",
    right: "0",
    bottom: "0",
    width: "14px",
    height: "14px",
    cursor: "nwse-resize",
    // Two diagonal strokes, the conventional corner grip, drawn in the dim
    // foreground so it reads in every theme without a hex colour.
    backgroundImage:
      "linear-gradient(135deg, transparent 0 55%, var(--color-fg-dim) 55% 62%, transparent 62% 75%, var(--color-fg-dim) 75% 82%, transparent 82%)",
    opacity: "0.6",
  },
  ".cm-lsp-usages-grip:hover, .cm-lsp-usages-resizing .cm-lsp-usages-grip": {
    opacity: "1",
  },
  ".cm-lsp-usages-resizing, .cm-lsp-usages-resizing *": {
    cursor: "nwse-resize !important",
    userSelect: "none",
  },
  ".cm-lsp-usages-head": {
    padding: "8px 12px",
    borderBottom: "1px solid var(--color-border)",
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    backgroundColor: "var(--color-bg-1)",
  },
  ".cm-lsp-usages-symbol": {
    fontWeight: "bold",
    color: "var(--color-accent)",
  },
  ".cm-lsp-usages-count": {
    color: "var(--color-fg-dim)",
    fontSize: "11px",
    marginLeft: "auto",
  },
  ".cm-lsp-usages-list": {
    overflowY: "auto",
    padding: "4px 0",
    flex: "1 1 auto",
    // A flex child's min-height defaults to its content, which would stop the
    // list shrinking below its rows when the popup is dragged smaller.
    minHeight: "0",
  },
  ".cm-lsp-usages-row": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 12px",
    cursor: "pointer",
    whiteSpace: "pre", // keeps indentation spaces
  },
  ".cm-lsp-usages-active": {
    backgroundColor: "var(--color-sel)",
  },
  ".cm-lsp-usages-icon": {
    width: "14px !important",
    height: "14px !important",
    flexShrink: 0,
    display: "block",
  },
  ".cm-lsp-usages-file": {
    color: "var(--color-fg)",
    fontWeight: "500",
    // A label is short by construction (bare name, or an elided path when two
    // files clash), but a deeply nested clash can still be long. Capped and
    // shrinkable rather than fixed, so a long one gives way to the code column
    // instead of pushing it off the row.
    flexShrink: 1,
    // A share of the row, not a fixed 26ch, so widening the popup widens the
    // file column too; at the default width this lands close to 26ch.
    maxWidth: "40%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-lsp-usages-line": {
    color: "var(--color-fg-dim)",
    minWidth: "3ch",
    textAlign: "right",
    flexShrink: 0,
  },
  ".cm-lsp-usages-code": {
    color: "var(--color-fg-dim)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontFamily: "var(--font-mono)",
    flex: "1 1 auto",
  },
  ".cm-lsp-usages-code strong": {
    color: "var(--color-fg)",
    fontWeight: "bold",
    backgroundColor: "var(--color-sel)",
    padding: "0 2px",
    borderRadius: "2px",
  },
  ".cm-lsp-usages-footer": {
    padding: "6px 12px",
    borderTop: "1px solid var(--color-border)",
    fontSize: "11px",
    color: "var(--color-fg-dim)",
    backgroundColor: "var(--color-bg-1)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 0,
    // Clear of the resize grip in the corner.
    paddingRight: "22px",
  },
  ".cm-lsp-usages-symbol-mark": {
    backgroundColor: "var(--color-sel)",
    borderBottom: "1px dashed var(--color-accent)",
  },
});

export const usagesPopup: Extension = [usagesField, usagesKeymap, symbolHighlight, usagesTheme];
