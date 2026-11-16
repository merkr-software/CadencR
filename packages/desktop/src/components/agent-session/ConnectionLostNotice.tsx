import { memo } from "react";
import { Loader2Icon } from "lucide-react";

/**
 * The client lost its connection to the service while the agent was working.
 * Not an error of the turn, and the client cannot tell what became of it: a
 * dropped connection leaves it running, a restarted service resumes it. So the
 * notice claims neither and offers nothing to continue or retry; the reconnect
 * resyncs the transcript, which shows what happened and removes this notice
 * (`ws-session-resync`). Same quiet line as the provider's own stream retry
 * (`AgentSessionStreamNotice`).
 */
export const ConnectionLostNotice = memo(function ConnectionLostNotice() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="my-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
    >
      <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
      <span className="shrink-0 font-medium text-foreground">Reconnecting…</span>
      <span className="min-w-0">
        The connection to Cadencr dropped. This conversation catches up once it is back.
      </span>
    </div>
  );
});
