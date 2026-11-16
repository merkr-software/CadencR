import type { RefObject } from "react";
import { toast } from "sonner";
import type { TerminalCoreInstanceHandle } from "@/components/terminal-core";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { addToPrompt, lineCountLabel } from "@/lib/add-to-prompt";

/** ⌘⇧↵ / Ctrl+Shift+Enter in the Terminal: the selected output → the composer. */
export function useAddTerminalSelectionToPrompt({
  featureId,
  enabled,
  activePaneId,
  paneRefs,
}: {
  featureId: number;
  enabled: boolean;
  activePaneId: string | null;
  paneRefs: RefObject<Map<string, TerminalCoreInstanceHandle>>;
}): void {
  useScopedGlobalShortcutById(
    "terminal-add-selection-to-prompt",
    (event) => {
      if (!activePaneId) return;
      event.preventDefault();
      event.stopPropagation();
      const text = paneRefs.current.get(activePaneId)?.getSelection() ?? null;
      if (!text?.trim()) {
        toast.error("Select terminal output first, then add it to the prompt.");
        return;
      }
      addToPrompt(featureId, {
        kind: "terminal",
        label: "Terminal output",
        detail: lineCountLabel(text),
        content: text,
      });
    },
    "terminal",
    { enabled: enabled && !!activePaneId },
  );
}
