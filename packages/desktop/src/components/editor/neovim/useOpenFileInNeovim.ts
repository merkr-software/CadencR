import { useCallback } from "react";
import { toast } from "sonner";
import { startRoute, useOpenFileRoute } from "@/api/generated";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";
import { focusNeovimEditor } from "./focusNeovimEditor";

/** Opens a path in the feature's Neovim session, at an optional 1-indexed line. */
export type OpenInNeovim = (filePath: string, line?: number, col?: number) => void;

/**
 * `undefined` unless the editor pane is actually showing Neovim — the caller
 * then keeps its normal CodeMirror path. Mirrors `EditorPane`'s own condition
 * (`level 2 && !mobile`), since the mobile fallback renders CodeMirror and no
 * Neovim session is started for it.
 */
export function useOpenFileInNeovim(
  featureId: number,
  { ensureStarted = false, onOpened }: { ensureStarted?: boolean; onOpened?: () => void } = {},
): OpenInNeovim | undefined {
  const vimModeLevel = useVimModeLevel();
  const isMobile = useIsMobile();
  const { mutateAsync } = useOpenFileRoute();

  const openInNeovim = useCallback<OpenInNeovim>(
    (filePath, line, col) => {
      const pending = toast.loading(`Opening ${filePath} in Neovim…`);
      void (async () => {
        try {
          // Diff links can reach the editor before its pane has ever mounted.
          if (ensureStarted) await startRoute(featureId);
          await mutateAsync({
            featureId: String(featureId),
            data: { path: filePath, line, col },
          });
          onOpened?.();
          // Allow a newly revealed pane to mount before transferring focus.
          requestAnimationFrame(() => focusNeovimEditor(featureId));
        } catch (error: unknown) {
          toast.error(`Could not open ${filePath} in Neovim`, {
            description: error instanceof Error ? error.message : String(error),
          });
        } finally {
          toast.dismiss(pending);
        }
      })();
    },
    [featureId, mutateAsync, ensureStarted, onOpened],
  );

  return vimModeLevel === "2" && !isMobile ? openInNeovim : undefined;
}
