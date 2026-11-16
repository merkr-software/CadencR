import { useCallback, type ReactElement } from "react";
import { toast } from "sonner";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { GatePopoverSheet } from "@/components/sidebar-gate-popover/GatePopoverSheet";
import { useCrossProjectNavigate } from "@/hooks/useCrossProjectNavigate";
import { attentionFeature } from "@/hooks/useGatePopoverContext";
import { useGateAdvance } from "@/hooks/useGateAdvance";
import { useGateQueueIds } from "@/hooks/useGateQueue";
import { useOpenGateQuickReply } from "@/hooks/useOpenGateQuickReply";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { mostRecentPendingFeatureId } from "@/stores/pending-gate-popover-selectors";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarOption } from "@/stores/sidebar-config-store";

/**
 * The parts of the quick reply that belong to no row: the phone's bottom sheet,
 * moving on after an answer, and the "Answer newest request" shortcut. Mounted
 * once, inside the sidebar (it reads the attention lists and navigates).
 */
export function PendingGateHost({
  activeFeatureId,
  onSelectFeature,
}: {
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}): ReactElement {
  const { items, actions } = useSidebarAttention();
  const navigate = useCrossProjectNavigate(activeFeatureId, onSelectFeature);
  useGateAdvance();
  useAnswerNewestShortcut();
  const openConversation = useCallback(
    (featureId: number): void => {
      const feature = attentionFeature({ items, actions }, featureId);
      if (feature) navigate(feature);
      else toast.error("Could not open the conversation: it is no longer in the sidebar");
    },
    [actions, items, navigate],
  );
  return <GatePopoverSheet onOpenConversation={openConversation} />;
}

/**
 * "Answer newest request": opens the newest request's quick reply as the
 * user's own, so focus lands on its first action. Needs the quick reply on.
 */
function useAnswerNewestShortcut(): void {
  const mode = useSidebarOption("gatePopover");
  const queue = useGateQueueIds();
  const openQuickReply = useOpenGateQuickReply();
  useGlobalShortcutById("answer-newest-request", (event) => {
    event.preventDefault();
    if (mode === "off") {
      toast.message("Quick reply is off: change it in the sidebar's display options");
      return;
    }
    const queued = new Set(queue);
    const featureId = mostRecentPendingFeatureId(
      useSessionStatusStore.getState().bySession,
      (entry) => queued.has(entry.featureId),
    );
    if (featureId == null) {
      toast.message("No request to answer here");
      return;
    }
    openQuickReply(featureId);
  });
}
