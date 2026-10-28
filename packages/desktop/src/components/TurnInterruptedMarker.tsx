import { memo } from "react";
import { Play, Power, RotateCw, Square } from "lucide-react";
import { useIsLatestBlock } from "@/hooks/useIsLatestBlock";
import { CONTINUE_PROMPT } from "@/lib/agent-error-presentation";
import { formatStreamTimestamp } from "@/lib/date-utils";
import { QUIT_INTERRUPTION, RESTART_INTERRUPTION } from "@/lib/agent-message-origin";
import { useAgentSessionContext } from "./agent-session/agent-session-context";

/**
 * Where a turn was cut short — by the user, by quitting Cadencr and choosing
 * to stop the agents, or by a Cadencr restart (an app update, a rebuild, a
 * crash). States it in the product's words instead of the
 * provider's raw "tool use was rejected" text, and — on the turn that just
 * ended — offers to pick the work back up. After a restart Cadencr usually
 * resumes the conversation itself, so the marker is no longer the latest block
 * and the button is not shown.
 */
export const TurnInterruptedMarker = memo(function TurnInterruptedMarker({
  blockId,
  cause,
}: {
  blockId: string;
  cause: string;
}) {
  const { wsSessionId, sendPrompt } = useAgentSessionContext();
  const isLatest = useIsLatestBlock(wsSessionId, blockId);
  const byRestart = cause === RESTART_INTERRUPTION;
  const byQuit = cause === QUIT_INTERRUPTION;
  return (
    <div
      data-turn-interrupted={byRestart ? "restart" : byQuit ? "quit" : "user"}
      className="my-2 flex items-center gap-3 text-xs text-muted-foreground"
      role="note"
    >
      <span className="h-px flex-1 bg-border/70" aria-hidden />
      <span className="inline-flex items-center gap-1.5">
        {byRestart ? (
          <RotateCw className="size-3" aria-hidden />
        ) : byQuit ? (
          <Power className="size-3" aria-hidden />
        ) : (
          <Square className="size-2.5 fill-current" aria-hidden />
        )}
        {byRestart
          ? "Interrupted by a Cadencr restart"
          : byQuit
            ? "Stopped when you quit Cadencr"
            : "Stopped by you"}
      </span>
      {isLatest && (
        <button
          type="button"
          onClick={() => sendPrompt(CONTINUE_PROMPT)}
          className="composer-instrument gap-1.5 text-foreground"
        >
          <Play className="size-3" aria-hidden />
          Resume
        </button>
      )}
      <span className="h-px flex-1 bg-border/70" aria-hidden />
    </div>
  );
});

/**
 * Where Cadencr picked a conversation back up after a restart (an app update,
 * a rebuild, a crash) cut its turn off. Stands in for both the interruption
 * marker and the "continue" prompt Cadencr sent, which the agent reads but
 * the person does not need to.
 */
export const RestartResumedDivider = memo(function RestartResumedDivider({
  sentAt,
}: {
  sentAt?: string;
}) {
  return (
    <div className="flex items-center gap-3 py-3" data-restart-resumed role="note">
      <div className="h-px flex-1 bg-primary/30" />
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
        <RotateCw className="size-3" aria-hidden />
        Resumed after restart
        {sentAt && (
          <span className="font-normal text-muted-foreground tabular-nums">
            · {formatStreamTimestamp(sentAt)}
          </span>
        )}
      </span>
      <div className="h-px flex-1 bg-primary/30" />
    </div>
  );
});
