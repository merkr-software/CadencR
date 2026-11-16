import { memo } from "react";
import { Loader2Icon } from "lucide-react";
import { useWsSessionStore } from "@/stores/ws-session-store";

/**
 * Quiet "Reconnecting…" line while the provider retries a dropped stream.
 * Driven only by `session.stream_status` (cleared by `recovered` or by the
 * turn's `session.ended`).
 */
export const AgentSessionStreamNotice = memo(function AgentSessionStreamNotice({
  sessionId,
}: {
  sessionId: string | undefined;
}) {
  const health = useWsSessionStore((state) =>
    sessionId ? state.sessions[sessionId]?.streamHealth : undefined,
  );
  if (health?.state !== "degraded") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mt-2 flex min-w-0 shrink-0 items-center gap-2 text-xs text-muted-foreground"
      title={health.reason}
    >
      <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
      <span className="shrink-0 font-medium text-foreground">Reconnecting…</span>
      {health.reason ? <span className="min-w-0 truncate">{health.reason}</span> : null}
    </div>
  );
});
