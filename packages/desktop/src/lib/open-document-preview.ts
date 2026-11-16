import {
  requestAutoReveal,
  type AutoRevealOutcome,
  type RevealSource,
} from "@/lib/auto-layout/auto-layout-controller";
import { useDocumentPreviewStore } from "@/stores/document-preview-store";
import { showBuiltinTab } from "@/lib/plugin-tabs/builtin-fallback";
import { activateFeatureTab } from "@/stores/feature-layout-store";

/**
 * Show `filePath` in the feature's Preview tab and bring the tab into view.
 *
 * With auto layout on, the Preview splits in beside the agent (or is
 * activated where it already sits), exactly like the Editor and Browser do.
 * Otherwise a user click activates the tab in place; an agent-driven open
 * only swaps the document, never the user's current tab.
 */
export function openDocumentPreview({
  featureId,
  layoutFeatureId,
  filePath,
  source,
}: {
  featureId: number;
  layoutFeatureId: number;
  filePath: string;
  source: RevealSource;
}): AutoRevealOutcome {
  useDocumentPreviewStore.getState().open(featureId, filePath);
  showBuiltinTab(layoutFeatureId, "preview");
  const outcome = requestAutoReveal(layoutFeatureId, "preview", source);
  if (outcome === "declined" && source === "user-link") {
    activateFeatureTab(layoutFeatureId, "preview");
  }
  return outcome;
}
