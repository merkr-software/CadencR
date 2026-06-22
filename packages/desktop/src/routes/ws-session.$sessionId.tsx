import { createFileRoute } from "@tanstack/react-router";
import { WebSocketSessionFeatureBlock } from "@/components/WebSocketSessionFeatureBlock";
import { ResolvedModelProvider } from "@/contexts/ResolvedModelContext";
import { useSaveLastOpenedFeature } from "@/hooks/useSaveLastOpenedFeature";
import { useMarkFeatureRead } from "@/stores/unread-store";
import {
  getFocusedTab,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { validateWsSessionSearch } from "./-ws-session-search";

export const Route = createFileRoute("/ws-session/$sessionId")({
  component: WebSocketSessionPage,
  validateSearch: validateWsSessionSearch,
});

function WebSocketSessionPage() {
  const { sessionId } = Route.useParams();
  const { cwd, featureId, projectId, focusTab } = Route.useSearch();
  // Persist the last-opened feature at the route (not the inner block) so we
  // don't double-PUT — `WebSocketSessionFeatureBlock` used to call this too.
  const layoutState = useFeatureLayoutStore(selectFeatureLayout(featureId));
  const focusedTabId = getFocusedTab(layoutState) ?? "agent";
  useSaveLastOpenedFeature(projectId, featureId, focusedTabId);
  // Opening a conversation reads it: clear any pending unread dot.
  useMarkFeatureRead(featureId);
  return (
    <ResolvedModelProvider featureId={featureId} projectId={projectId}>
      <WebSocketSessionFeatureBlock
        sessionId={sessionId}
        cwd={cwd}
        featureId={featureId}
        projectId={projectId}
        requestedFocusTab={focusTab}
      />
    </ResolvedModelProvider>
  );
}
