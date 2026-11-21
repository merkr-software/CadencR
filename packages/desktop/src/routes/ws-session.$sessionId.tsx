import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePool } from "@/components/workspace-pool/WorkspacePool";
import type { WorkspaceTarget } from "@/components/workspace-pool/workspace-pool-state";
import { validateWsSessionSearch } from "./-ws-session-search";

export const Route = createFileRoute("/ws-session/$sessionId")({
  component: WebSocketSessionPage,
  validateSearch: validateWsSessionSearch,
});

/**
 * One instance serves every conversation: the root keys its outlet on the
 * route, not on the session, so switching conversation re-renders this page
 * with new params and the pool decides what to mount, show and keep.
 */
function WebSocketSessionPage() {
  const { sessionId } = Route.useParams();
  const { cwd, featureId, projectId, focusTab } = Route.useSearch();
  const target = useMemo<WorkspaceTarget>(
    () => ({ sessionId, cwd, featureId, projectId, focusTab }),
    [cwd, featureId, focusTab, projectId, sessionId],
  );
  return <WorkspacePool target={target} />;
}
