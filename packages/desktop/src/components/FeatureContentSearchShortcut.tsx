import { useCallback, useState, type ReactElement } from "react";
import { LazyBoundary } from "@/components/lazy/LazyBoundary";
import { preloadableChunk } from "@/components/lazy/lazy-chunk";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { activateBuiltinFeatureTab } from "@/lib/plugin-tabs/builtin-fallback";

// CodeMirror and its grammars come with the dialog, in its own chunk: under
// a mouse it is fetched once idle after the first paint
// (`useKeyboardSurfacePrefetch`), under a finger on first use.
const contentSearchChunk = preloadableChunk(() =>
  import("@/components/editor/ContentSearchDialog").then((module) => module.default),
);
const ContentSearchDialog = contentSearchChunk.Component;
export const preloadContentSearch = contentSearchChunk.preload;
export const prefetchContentSearch = contentSearchChunk.prefetch;

interface FeatureContentSearchShortcutProps {
  featureId: number;
  projectId: number;
  enabled?: boolean;
  layoutFeatureId?: number;
}

export function FeatureContentSearchShortcut({
  featureId,
  projectId,
  enabled = true,
  layoutFeatureId = featureId,
}: FeatureContentSearchShortcutProps): ReactElement | null {
  const [open, setOpen] = useState(false);

  const activateEditorTab = useCallback((): void => {
    activateBuiltinFeatureTab(layoutFeatureId, "editor");
  }, [layoutFeatureId]);

  useGlobalShortcutById(
    "content-search",
    (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setOpen(true);
    },
    { enabled },
  );

  return open ? (
    <LazyBoundary label="search" variant="overlay" onDismiss={() => setOpen(false)}>
      <ContentSearchDialog
        projectId={projectId}
        featureId={featureId}
        open={open}
        onOpenChange={setOpen}
        onResultOpen={activateEditorTab}
      />
    </LazyBoundary>
  ) : null;
}
