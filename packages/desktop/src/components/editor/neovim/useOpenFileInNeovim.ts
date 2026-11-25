import { translateUi } from "@/lib/i18n/ui";
import { useCallback } from "react";
import { toast } from "sonner";
import { startRoute, useOpenFileRoute } from "@/api/generated";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";
import { apiErrorMessage } from "@/lib/api-errors";
import { focusNeovimEditor } from "./focusNeovimEditor";

/**
 * Opens a path in the feature's Neovim session, at an optional 1-indexed line.
 * `revealEditor` runs once the PTY exists, so startup prompts remain accessible
 * while the file-open request waits for Neovim's initialization.
 */
export type OpenInNeovim = (
  filePath: string,
  line?: number,
  col?: number,
  revealEditor?: () => void,
) => void;

/**
 * `undefined` unless the editor pane is actually showing Neovim — the caller
 * then keeps its normal CodeMirror path. Mirrors `EditorPane`'s own condition
 * (`level 2 && !mobile`), since the mobile fallback renders CodeMirror and no
 * Neovim session is started for it.
 */
export function useOpenFileInNeovim(
  featureId: number,
  { ensureStarted = false }: { ensureStarted?: boolean } = {},
): OpenInNeovim | undefined {
  const vimModeLevel = useVimModeLevel();
  const isMobile = useIsMobile();
  const { mutateAsync } = useOpenFileRoute();

  const openInNeovim = useCallback<OpenInNeovim>(
    (filePath, line, col, revealEditor) => {
      const pending = toast.loading(
        translateUi("workspace.editor.useOpenFileInNeovim.opening", "Opening {{path}} in Neovim…", {
          path: filePath,
        }),
      );
      void (async () => {
        try {
          // Diff links can reach the editor before its pane has ever mounted.
          if (ensureStarted) await startRoute(featureId);
          revealEditor?.();
          await mutateAsync({
            featureId: String(featureId),
            data: { path: filePath, line, col },
          });
          // Transfer focus once the requested file is ready for interaction.
          requestAnimationFrame(() => focusNeovimEditor(featureId));
        } catch (error: unknown) {
          toast.error(
            translateUi(
              "workspace.editor.useOpenFileInNeovim.openFailed",
              "Could not open {{path}} in Neovim",
              { path: filePath },
            ),
            {
              description: apiErrorMessage(
                error,
                translateUi("workspace.editor.useOpenFileInNeovim.cannotOpen", "Cannot open file"),
              ),
            },
          );
        } finally {
          toast.dismiss(pending);
        }
      })();
    },
    [featureId, mutateAsync, ensureStarted],
  );

  return vimModeLevel === "2" && !isMobile ? openInNeovim : undefined;
}
