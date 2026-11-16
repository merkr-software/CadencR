import { startTransition, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { WebSocketSessionFeatureBlock } from "@/components/WebSocketSessionFeatureBlock";
import { FeatureWorkspaceSkeleton } from "@/components/FeatureWorkspaceSkeleton";
import { ResolvedModelProvider } from "@/contexts/ResolvedModelContext";
import { useSaveLastOpenedFeature } from "@/hooks/useSaveLastOpenedFeature";
import { useMarkFeatureRead } from "@/stores/for-me-ack";
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
  // Opening a conversation reads it (unless For me clears only when done).
  useMarkFeatureRead(featureId);
  // Mounting the whole workspace (agent Virtuoso + Lexical composer + the staged
  // side panels) in the switch's commit is what drives the switch INP up. Paint
  // a cheap skeleton first, then mount the real workspace one paint later — see
  // `useDeferredWorkspaceMount`.
  const workspaceReady = useDeferredWorkspaceMount();
  return (
    <ResolvedModelProvider featureId={featureId}>
      <LastOpenedFeatureSaver projectId={projectId} featureId={featureId} />
      {workspaceReady ? (
        <WebSocketSessionFeatureBlock
          sessionId={sessionId}
          cwd={cwd}
          featureId={featureId}
          projectId={projectId}
          requestedFocusTab={focusTab}
        />
      ) : (
        <FeatureWorkspaceSkeleton />
      )}
    </ResolvedModelProvider>
  );
}

/**
 * Persists the last-opened feature at the route (not the inner block) so we
 * don't double-PUT. A leaf of its own: it follows the focused tab, which
 * changes on every pane focus, and the page must not re-render the workspace
 * for that.
 */
function LastOpenedFeatureSaver({
  projectId,
  featureId,
}: {
  projectId: number;
  featureId: number;
}): null {
  const focusedTabId = useFeatureLayoutStore(
    (s) => getFocusedTab(selectFeatureLayout(featureId)(s)) ?? "agent",
  );
  useSaveLastOpenedFeature(projectId, featureId, focusedTabId);
  return null;
}

/**
 * Gate the heavy workspace mount to just after the skeleton paints.
 *
 * The skeleton commits and paints in response to the switch — that paint is the
 * switch's INP. This passive effect then runs *after* that paint and promotes
 * to the real workspace, so the heavy mount lands off the interaction's
 * critical commit. `startTransition` marks that second render non-urgent so a
 * follow-up switch (an urgent remount) can interrupt it. The route remounts on
 * every switch (the root keys `<Outlet>` on pathname), so a plain boolean
 * re-defers correctly each time.
 */
function useDeferredWorkspaceMount(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    startTransition(() => setReady(true));
  }, []);
  return ready;
}
