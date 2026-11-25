import { contextItemDetail, contextItemLabel } from "@/lib/composer-context-presentation";
import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";
import {
  composerKeyFor,
  useComposerContextStore,
  type ComposerContextItem,
} from "@/stores/composer-context-store";

/**
 * Put a piece of the workspace (an editor selection, terminal output…) in a
 * conversation composer's context tray. Not sent: the user still writes what
 * to do with it.
 */
export function addToPrompt(featureId: number, item: Omit<ComposerContextItem, "id">): void {
  useComposerContextStore.getState().add(composerKeyFor(featureId), item);
  toast.success(
    translateUi("conversation.composer.add-to-prompt.added", "Added to the agent prompt"),
    {
      description: [contextItemLabel(translateUi, item), contextItemDetail(translateUi, item)]
        .filter(Boolean)
        .join(" · "),
    },
  );
}

export function lineCountLabel(text: string): string {
  const lines = text.split("\n").length;
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}
