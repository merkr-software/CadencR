import { useEffect } from "react";
import type { OpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import { useCliFileOpenStore } from "@/stores/cli-file-open-store";

/**
 * Opens the file `cadencr open` asked for once this conversation's workspace is
 * up, through the same path as a clicked file reference (Neovim, document
 * preview or the editor).
 */
export function useCliPendingFileOpen(
  featureId: number,
  enabled: boolean,
  open: OpenDiffInEditor,
): void {
  const waiting = useCliFileOpenStore((state) => state.pending?.featureId === featureId);
  useEffect(() => {
    if (!enabled || !waiting) return;
    const pending = useCliFileOpenStore.getState().take(featureId);
    if (pending) open(pending.relativePath, pending.line);
  }, [enabled, featureId, open, waiting]);
}
