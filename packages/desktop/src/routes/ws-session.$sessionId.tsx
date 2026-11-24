import { createFileRoute } from "@tanstack/react-router";
import { validateWsSessionSearch } from "./-ws-session-search";

export const Route = createFileRoute("/ws-session/$sessionId")({
  component: WebSocketSessionPage,
  validateSearch: validateWsSessionSearch,
});

/**
 * Renders nothing: the conversation is shown by the root's conversation layer
 * (`components/app-stage/ConversationLayer.tsx`), which reads this route's
 * match. Its workspaces (`WorkspacePool`) live there, above the route, so they
 * survive the phone inbox and a layout flip; switching conversation re-renders
 * the layer with the new params and the pool decides what to mount, show and
 * keep.
 */
function WebSocketSessionPage(): null {
  return null;
}
