import { useState, type ReactNode } from "react";

import { useFeatureLayoutContext } from "@/components/feature-layout/FeatureLayoutContext";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { useReplacementShownTabs } from "@/lib/plugin-tabs/builtin-fallback";
import {
  getFocusedTab,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";

import { LazyBoundary } from "@/components/lazy/LazyBoundary";
import { preloadableChunk } from "@/components/lazy/lazy-chunk";

// The picker (file icons, fuzzy search) in its own chunk: under a mouse it is
// fetched once idle after the first paint (`useKeyboardSurfacePrefetch`),
// under a finger on first use.
const fileSearchChunk = preloadableChunk(() =>
  import("./FileSearchDialog").then((module) => module.default),
);
const FileSearchDialog = fileSearchChunk.Component;
export const preloadFileSearch = fileSearchChunk.preload;
export const prefetchFileSearch = fileSearchChunk.prefetch;

interface EditorFuzzyShortcutProps {
  /** Real feature id used by the editor store (file open / pane state). */
  featureId: number;
  projectId: number;
  enabled?: boolean;
}

/**
 * Always-mounted CMD+P binding for the editor's fuzzy file picker. Lives at
 * the WS feature block (not inside `FeatureEditorTab`, which is lazy-loaded)
 * so the window listener is attached before the editor chunk resolves —
 * otherwise pressing CMD+P right after clicking the Editor tab falls into
 * the load gap and is silently dropped.
 *
 * `enabled` mirrors the host's `hotkeysEnabled` (= `isActive` per card in
 * unified mode, always-true on the standalone route) so only one card's
 * listener fires.
 */
export function EditorFuzzyShortcut({
  featureId,
  projectId,
  enabled = true,
}: EditorFuzzyShortcutProps): ReactNode {
  const [open, setOpen] = useState(false);
  const layoutFeatureId = useFeatureLayoutContext()?.featureId ?? featureId;
  const isEditorFocused = useFeatureLayoutStore(
    (s) => getFocusedTab(selectFeatureLayout(layoutFeatureId)(s)) === "editor",
  );
  // A custom tab in the Editor's place (docs/CUSTOM_TABS.md §10) has no file search.
  const editorReplaced = useReplacementShownTabs(layoutFeatureId).includes("editor");

  useGlobalShortcutById(
    "editor-fuzzy",
    (e) => {
      if (!isEditorFocused || editorReplaced) return;
      e.preventDefault();
      setOpen(true);
    },
    { enabled },
  );

  if (!open) return null;
  return (
    <LazyBoundary label="file search" variant="overlay" onDismiss={() => setOpen(false)}>
      <FileSearchDialog
        projectId={projectId}
        featureId={featureId}
        open={open}
        onOpenChange={setOpen}
      />
    </LazyBoundary>
  );
}
