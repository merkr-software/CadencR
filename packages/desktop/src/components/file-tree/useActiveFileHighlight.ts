import { useMemo } from "react";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { useFileTreeShadowStylesheet } from "@/components/file-tree/useFileTreeShadowStylesheet";

/**
 * Paint the editor-active file row in the file tree so the user can
 * locate the file they're currently editing at a glance.
 *
 * Per `DESIGN.md` → EditorPanel: "Explorer item active" uses `--primary`
 * mixed at 28% as the background — a tint, not a saturated fill, so it
 * blends with the sidebar surface.
 *
 * Why CSS injection (not pierre's selection / focus APIs)?
 *  - `setSelectedPaths` is shared with drag-and-drop and shift-click
 *    multi-select; pinning it to the active file would collide with
 *    those flows.
 *  - `focusPath` only paints the keyboard focus ring, which moves to
 *    whichever row the user last clicked or arrowed to — a transient
 *    cursor, not a sticky "this file is open" hint.
 *
 * Pierre stamps `data-item-path` on every visible row, so a single
 * attribute selector survives virtualization. The `:hover` variant is
 * mandatory: pierre paints a `--sidebar-accent` background on hover with
 * equal selector specificity, which would otherwise mask the active
 * hint while the cursor is over the row.
 *
 * We intentionally don't override `color`. If the active file sits inside
 * a gitignored sub-tree, `useGitignoredDimming`'s muted text color stays
 * applied — the user can see both that the file is open AND that it's
 * ignored.
 */
export function useActiveFileHighlight(model: FileTreeModel, activeFilePath: string | null): void {
  const css = useMemo(() => buildActiveFileCSS(activeFilePath), [activeFilePath]);
  useFileTreeShadowStylesheet(model, "data-cadencr-active-file", css);
}

function buildActiveFileCSS(activeFilePath: string | null): string {
  if (!activeFilePath) return "";
  const selector = `[data-item-path="${CSS.escape(activeFilePath)}"]`;
  const tint = "color-mix(in oklch, var(--primary) 28%, transparent)";
  return `${selector},\n${selector}:hover {\n  background-color: ${tint};\n}`;
}
