import { memo, type ReactElement } from "react";
import { Loader2Icon, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWsSessionStore } from "@/stores/ws-session-store";

const TITLE = "Couldn't load this conversation's history";

function useHistoryLoadFailure(sessionId: string | undefined) {
  return useWsSessionStore((state) =>
    sessionId ? (state.sessions[sessionId]?.historyLoadFailure ?? null) : null,
  );
}

/**
 * Whether the conversation's saved history has not arrived yet. An entry that
 * does not exist yet counts: the workspace creates it in its first effect.
 */
export function useIsHistoryLoading(sessionId: string | undefined): boolean {
  return useWsSessionStore(
    (state) => sessionId !== undefined && state.sessions[sessionId]?.persistedLoaded !== true,
  );
}

function RetryButton({ sessionId, retrying }: { sessionId: string; retrying: boolean }) {
  const waitingForSocket = useWsSessionStore((state) => {
    const session = state.sessions[sessionId];
    return session?.historyLoadFailure?.resyncSessionDbId !== undefined && !session.isConnected;
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={retrying || waitingForSocket}
      onClick={() => useWsSessionStore.getState().retryPersistedLoad(sessionId)}
    >
      {retrying ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
      {waitingForSocket ? "Reconnecting…" : retrying ? "Loading…" : "Retry"}
    </Button>
  );
}

/**
 * The saved history failed to load: said in the transcript, with a retry,
 * rather than leaving an empty conversation. `empty` fills an otherwise empty
 * transcript; `notice` is a strip above the composer once live output exists.
 */
export const AgentSessionHistoryFailure = memo(function AgentSessionHistoryFailure({
  sessionId,
  variant,
}: {
  sessionId: string | undefined;
  variant: "empty" | "notice";
}): ReactElement | null {
  const failure = useHistoryLoadFailure(sessionId);
  if (!sessionId || !failure) return null;
  const empty = variant === "empty";
  return (
    <div
      role="alert"
      className={cn(
        "flex min-w-0 text-xs",
        empty
          ? "max-w-sm flex-col items-center gap-2 text-center"
          : "mx-4 mt-2 shrink-0 items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2",
      )}
    >
      <TriangleAlert
        className={cn("shrink-0 text-destructive", empty ? "size-5" : "mt-0.5 size-3.5")}
        aria-hidden
      />
      <div className={cn("min-w-0", !empty && "flex-1")}>
        <p className="text-sm font-medium text-foreground">
          {failure.resyncSessionDbId === undefined
            ? TITLE
            : "Could not refresh conversation history"}
        </p>
        <p className="mt-0.5 break-words text-muted-foreground">{failure.message}</p>
      </div>
      <RetryButton sessionId={sessionId} retrying={failure.retrying} />
    </div>
  );
});

/** Whether the session's saved history failed to load (and isn't loaded yet). */
export function useHasHistoryLoadFailure(sessionId: string | undefined): boolean {
  return useHistoryLoadFailure(sessionId) !== null;
}

/**
 * Whether the conversation is new: no transcript, and not because its saved
 * history failed to load. Gates every first-prompt setup (launch manifest,
 * worktree chip and picker, branch provisioning).
 */
export function useIsNewConversation(sessionId: string | undefined, blockCount: number): boolean {
  return isNewConversation(blockCount, useHasHistoryLoadFailure(sessionId));
}

/** `useIsNewConversation` outside React. */
export function isNewConversation(blockCount: number, historyFailed: boolean): boolean {
  return blockCount === 0 && !historyFailed;
}
