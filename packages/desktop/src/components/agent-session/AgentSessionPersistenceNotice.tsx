import { memo } from "react";
import { TriangleAlert } from "lucide-react";
import { useWsSessionStore } from "@/stores/ws-session-store";

/** Outside the virtualized transcript so an unsaved-output warning stays visible. */
export const AgentSessionPersistenceNotice = memo(function AgentSessionPersistenceNotice({
  sessionId,
}: {
  sessionId: string | undefined;
}) {
  const persistence = useWsSessionStore((state) =>
    sessionId ? state.sessions[sessionId]?.persistenceStatus : null,
  );
  if (!persistence || persistence.status === "recovered") return null;

  return (
    <div
      role="alert"
      className="mx-4 mt-2 flex shrink-0 items-start gap-2 rounded-md border border-[var(--acc-yellow)]/30 bg-[var(--acc-yellow)]/10 px-3 py-2 text-xs text-foreground"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-yellow)]" aria-hidden />
      <div>
        <span className="font-medium">
          {persistence.status === "failed"
            ? "Conversation history incomplete"
            : "Saving interrupted"}
        </span>
        <p className="mt-0.5 text-muted-foreground">{persistence.message}</p>
      </div>
    </div>
  );
});
