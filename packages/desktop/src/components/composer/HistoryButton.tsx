import { memo, useRef, useState, type ReactElement } from "react";
import { History } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { useShortcutKeys, useShortcutLabel } from "@/hooks/useShortcutLabel";
import { usePromptStashStore } from "@/stores/prompt-stash-store";
import { ShortcutTooltip } from "../ShortcutTooltip";
import { useComposerContext } from "./ComposerContext";
import { HistoryPanel } from "./HistoryPanel";

/** True when keyboard focus is inside the composer that owns `anchor`. */
function focusIsInComposer(anchor: HTMLElement | null): boolean {
  const composer = anchor?.closest("[data-agent-prompt-bar]");
  return !!composer && composer.contains(document.activeElement);
}

/**
 * Prompt history and stashed drafts. Ctrl+R opens a searchable list (like a
 * shell's reverse search) of the project's recent prompts and stashed drafts;
 * Ctrl+S sets the current draft aside without losing it.
 */
export const HistoryButton = memo(function HistoryButton(): ReactElement | null {
  const { projectId, editor, history } = useComposerContext();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const searchKeys = useShortcutKeys("prompt-history-search");
  const searchLabel = useShortcutLabel("prompt-history-search");

  useScopedShortcut(
    "prompt-history-search",
    (event) => {
      if (!focusIsInComposer(anchorRef.current)) return;
      event.preventDefault();
      setOpen(true);
    },
    "agent",
    { enabled: projectId != null },
  );
  useScopedShortcut(
    "prompt-stash-draft",
    (event) => {
      if (projectId == null || !focusIsInComposer(anchorRef.current)) return;
      event.preventDefault();
      const text = editor.getText().trim();
      if (!text) {
        toast.info("Nothing to stash: the draft is empty.");
        return;
      }
      usePromptStashStore.getState().push(projectId, text);
      editor.setText("");
      toast.success("Draft stashed", { description: `${searchLabel} brings it back.` });
    },
    "agent",
    { enabled: projectId != null },
  );

  if (projectId == null) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) requestAnimationFrame(() => editor.focus());
      }}
    >
      <ShortcutTooltip label="History & stashed drafts" keys={searchKeys} disabled={open}>
        <PopoverTrigger asChild>
          <button
            ref={anchorRef}
            type="button"
            aria-label="Prompt history and stashed drafts"
            data-composer-secondary
            className="composer-instrument composer-instrument-icon text-muted-foreground"
          >
            <History className="size-3.5" />
          </button>
        </PopoverTrigger>
      </ShortcutTooltip>
      <PopoverContent side="top" align="end" className="w-[min(30rem,calc(100vw-1.5rem))] p-0">
        <HistoryPanel
          projectId={projectId}
          history={history}
          onPick={(text) => {
            editor.setText(text);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
});
