import { useCallback, useMemo } from "react";
import { promptDropTargetIdOf } from "@/lib/prompt-drop-target";
import { hasUnsavedEditorWork } from "@/stores/editor-helpers";
import { useEditorStore } from "@/stores/editor-store";
import type { TabKind } from "@/stores/feature-layout-schema";
import { useAgentFirstNonAgentWork, useStaggeredTabReadiness } from "./useAgentFirstNonAgentWork";
import { useAgentDropZone } from "./WebSocketSessionFeatureBlockLocalHooks";

/**
 * The side tabs' gate and stagger. A tab requested by the navigation
 * (`requestedFocusTab`) counts only until it is applied: from then on the
 * focused tab says which one the user is on. The side tabs of a hidden
 * workspace do not close while its editor holds unsaved work.
 */
export function useNonAgentTabReadiness({
  embedded,
  featureId,
  focusedTabId,
  requestedFocusTab,
  requestedFocusPending,
  sessionId,
}: {
  embedded: boolean;
  featureId: number;
  focusedTabId: TabKind;
  requestedFocusTab: TabKind | undefined;
  requestedFocusPending: boolean;
  sessionId: string;
}) {
  const pendingRequest = requestedFocusPending ? requestedFocusTab : undefined;
  const immediateTab: TabKind | null =
    focusedTabId !== "agent"
      ? focusedTabId
      : pendingRequest != null && pendingRequest !== "agent"
        ? pendingRequest
        : null;
  const requested = immediateTab !== null;
  const canClose = useCallback(
    (): boolean => !hasUnsavedEditorWork(useEditorStore.getState().features[featureId]),
    [featureId],
  );
  const workEnabled = useAgentFirstNonAgentWork({
    enabled: !embedded || requested,
    immediate: requested,
    resetKey: sessionId,
    canClose,
  });
  const tabReady = useStaggeredTabReadiness({
    enabled: workEnabled,
    immediateTab,
    resetKey: sessionId,
  });
  return useMemo(() => ({ workEnabled, tabReady }), [tabReady, workEnabled]);
}

export function useSessionPromptDropZone(sessionId: string, featureId: number) {
  const promptDropTargetId = useMemo(
    () => promptDropTargetIdOf({ wsSessionId: sessionId, featureId }),
    [sessionId, featureId],
  );
  const agentDropZone = useAgentDropZone();
  return useMemo(
    () => ({ agentDropZone, promptDropTargetId }),
    [agentDropZone, promptDropTargetId],
  );
}
