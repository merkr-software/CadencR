import { useMatch } from "@tanstack/react-router";
import type { WorkspaceTarget } from "@/components/workspace-pool/workspace-pool-state";

const CONVERSATION_ROUTE = "/ws-session/$sessionId";

interface ConversationMatchSlice {
  status: string;
  searchError: unknown;
}

/**
 * Whether the route's match resolved: a malformed deep link (a search param
 * missing or not a number) fails `validateSearch`, and its match then holds
 * the raw strings. The route's error UI shows it; no workspace mounts.
 */
function isResolved(match: ConversationMatchSlice): boolean {
  return match.status === "success" && match.searchError === undefined;
}

/**
 * The conversation the route asks to show, or null on any other page and
 * while its match is not resolved. Read from the route's match, so it works
 * above the route's own component. Selects only the target's primitives with
 * structural sharing: the caller re-renders when the conversation or its tab
 * request changes, not on every match update (status, loader bookkeeping),
 * and the returned object keeps its identity while equal.
 */
export function useConversationTarget(): WorkspaceTarget | null {
  return (
    useMatch({
      from: CONVERSATION_ROUTE,
      shouldThrow: false,
      structuralSharing: true,
      select: (match): WorkspaceTarget | null =>
        isResolved(match)
          ? {
              sessionId: match.params.sessionId,
              cwd: match.search.cwd,
              featureId: match.search.featureId,
              projectId: match.search.projectId,
              focusTab: match.search.focusTab,
            }
          : null,
    }) ?? null
  );
}
