import { useCallback } from "react";
import { useGateAutoOpenOwner } from "@/hooks/useOwnsGateAutoOpen";
import { useUsesGateSheet } from "@/hooks/useUsesGateSheet";
import { resolveGateSurface } from "@/lib/pending-gate-surface";
import { useSidebarSample } from "@/lib/sidebar-sample-context";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";

/**
 * Opens a conversation's quick reply as the user's own (focus goes inside): on
 * the surface the open one was on when its row shows it there, else on the
 * surface that owns the newest request, else wherever the conversation
 * renders; a phone, or a conversation with no row on screen, gets the bottom
 * sheet. Called from a display options preview, it stays on the preview's rows
 * (a sample has no sheet). The callback changes with the owning surface and
 * the layout: call it from an event handler, not an effect dependency.
 */
export function useOpenGateQuickReply(): (featureId: number) => void {
  const usesSheet = useUsesGateSheet();
  const owner = useGateAutoOpenOwner();
  const preview = useSidebarSample() !== null;
  return useCallback(
    (featureId: number): void => {
      const store = usePendingGatePopoverStore.getState();
      const surface = usesSheet
        ? "sheet"
        : resolveGateSurface(featureId, [store.open?.surface, owner]);
      if (preview && surface === "sheet") return;
      store.openGate({ featureId, surface, origin: "user", preview });
    },
    [usesSheet, owner, preview],
  );
}
