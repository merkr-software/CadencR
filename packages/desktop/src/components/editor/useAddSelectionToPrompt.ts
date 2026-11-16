import type { EditorView } from "@codemirror/view";
import { toast } from "sonner";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { addToPrompt } from "@/lib/add-to-prompt";
import { langFromPath } from "@/lib/parse-unified-diff";

/** ⌘⇧↵ in the Editor: the selection (with its path and lines) → the composer. */
export function useAddSelectionToPrompt({
  featureId,
  enabled,
  getActive,
}: {
  featureId: number;
  enabled: boolean;
  getActive: () => { view: EditorView; filePath: string } | null;
}): void {
  useScopedGlobalShortcutById(
    "editor-add-selection-to-prompt",
    (event) => {
      const active = getActive();
      if (!active) return;
      event.preventDefault();
      event.stopPropagation();
      const { state } = active.view;
      const range = state.selection.main;
      if (range.empty) {
        toast.error("Select some code first, then add it to the prompt.");
        return;
      }
      const startLine = state.doc.lineAt(range.from).number;
      const endLine = state.doc.lineAt(range.to).number;
      addToPrompt(featureId, {
        kind: "selection",
        label: active.filePath,
        detail: startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`,
        content: state.sliceDoc(range.from, range.to),
        language: fenceLanguage(active.filePath),
      });
    },
    "editor",
    { enabled },
  );
}

/** The selection's code-fence language; an unknown file gets a bare fence. */
function fenceLanguage(path: string): string {
  const language = langFromPath(path);
  return language === "plaintext" ? "" : language;
}
