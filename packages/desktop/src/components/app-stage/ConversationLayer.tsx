import { memo, type ReactElement } from "react";
import { WorkspacePool } from "@/components/workspace-pool/WorkspacePool";
import { cn } from "@/lib/utils";
import { useConversationTarget } from "./conversation-match";

/**
 * The conversation workspaces (`WorkspacePool`), mounted by the root rather
 * than by the `ws-session` route, so they outlive the phone inbox: going to
 * the inbox hides every workspace, coming back shows the same one again,
 * scrolled where it was, with no history to fetch. It sits over the routed
 * page, which renders nothing for a conversation; while no conversation is on
 * screen (another page, or a conversation link whose match did not resolve)
 * it lets every press through to that page.
 */
export const ConversationLayer = memo(function ConversationLayer({
  shown,
}: {
  shown: boolean;
}): ReactElement {
  const conversation = useConversationTarget();
  // Shown only with a resolved conversation: an unresolved deep link leaves
  // the route's error UI under it, reachable.
  const target = shown ? conversation : null;
  return (
    <div
      data-conversation-layer={target ? "shown" : "hidden"}
      className={cn(
        "absolute inset-0",
        // The fade the routed page gets when it mounts, each time it shows.
        target ? "animate-in fade-in-0 duration-200 ease-out" : "pointer-events-none",
      )}
    >
      <WorkspacePool target={target} />
    </div>
  );
});
