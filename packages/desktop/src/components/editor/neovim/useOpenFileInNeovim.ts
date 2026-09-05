import { useCallback } from "react";
import { toast } from "sonner";
import { useOpenFileRoute } from "@/api/generated";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";

/** Opens a path in the feature's Neovim session, at an optional 1-indexed line. */
export type OpenInNeovim = (filePath: string, line?: number, col?: number) => void;

/**
 * `undefined` unless the editor pane is actually showing Neovim — the caller
 * then keeps its normal CodeMirror path. Mirrors `EditorPane`'s own condition
 * (`level 2 && !mobile`), since the mobile fallback renders CodeMirror and no
 * Neovim session is started for it.
 */
export function useOpenFileInNeovim(featureId: number): OpenInNeovim | undefined {
  const vimModeLevel = useVimModeLevel();
  const isMobile = useIsMobile();
  const { mutateAsync } = useOpenFileRoute();

  const openInNeovim = useCallback<OpenInNeovim>(
    (filePath, line, col) => {
      // The caller (file tree, diff view, ...) keeps DOM focus after the
      // click — nothing here re-targets it, so arrow keys would keep driving
      // whatever list was clicked instead of Neovim. `NeovimPane`'s host
      // element carries the `aria-label` a real click already focuses; do
      // the same here rather than plumbing a ref through the file tree and
      // every other future caller.
      document.querySelector<HTMLElement>('[aria-label="Neovim editor"]')?.focus();

      // Errors must be visible: a click that silently does nothing is the exact
      // failure mode the repo's error-handling rule forbids.
      void mutateAsync({
        featureId: String(featureId),
        data: { path: filePath, line, col },
      }).catch((error: unknown) => {
        toast.error(`Could not open ${filePath} in Neovim`, {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [featureId, mutateAsync],
  );

  return vimModeLevel === "2" && !isMobile ? openInNeovim : undefined;
}
