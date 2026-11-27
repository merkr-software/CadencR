import { useCallback, useMemo, type RefObject } from "react";
import { toast } from "sonner";
import { translateUi } from "@/lib/i18n/ui";
import type { TerminalCoreInstanceHandle } from "@/components/terminal-core";

export function useTerminalClipboard(paneRefs: RefObject<Map<string, TerminalCoreInstanceHandle>>) {
  const copyPaneSelection = useCallback(
    async (paneId: string): Promise<void> => {
      // No DOM selection to hand `execCommand` — the terminal draws to a
      // WebGPU canvas, so the text lives only in celeritty's own selection
      // buffer.
      const text = paneRefs.current.get(paneId)?.getSelection() ?? null;
      if (!text) {
        toast.error(
          translateUi(
            "workspace.tools.useTerminalPanelController.noTerminalSelectionToCopy",
            "No terminal selection to copy",
          ),
        );
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast.success(
          translateUi(
            "workspace.tools.useTerminalPanelController.terminalSelectionCopied",
            "Terminal selection copied",
          ),
        );
      } catch {
        toast.error(
          translateUi(
            "workspace.tools.useTerminalPanelController.failedToCopyToClipboard",
            "Failed to copy to clipboard",
          ),
        );
      }
    },
    [paneRefs],
  );
  const pasteIntoPane = useCallback(
    async (paneId: string): Promise<void> => {
      try {
        const text = await navigator.clipboard.readText();
        // `write` is local-only injection (used for initialNotice) and never
        // reaches the shell — `paste` sends it through the PTY, as if typed.
        if (text) paneRefs.current.get(paneId)?.paste(text);
      } catch {
        toast.error(
          translateUi(
            "workspace.tools.useTerminalPanelController.failedToPasteFromClipboard",
            "Failed to paste from clipboard",
          ),
        );
      }
    },
    [paneRefs],
  );
  return useMemo(() => ({ copyPaneSelection, pasteIntoPane }), [copyPaneSelection, pasteIntoPane]);
}
