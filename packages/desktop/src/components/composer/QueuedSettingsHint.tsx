import { memo, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { capitalize } from "@/lib/utils";
import { useWsSessionStore } from "@/stores/ws-session-store";

const NO_ACTIONS: readonly string[] = [];

/** What each replayable session setting is called in the read-out. */
const SETTING_NAMES: Readonly<Record<string, string>> = {
  "provider.set": "provider",
  "model.set": "model",
  "effort.set": "thinking effort",
  "profile.set": "profile",
  "mode.set": "permission mode",
  "access_mode.set": "access mode",
  "runtime_overrides.set:model": "model",
  "runtime_overrides.set:thinking_effort": "thinking effort",
};

/** "Model change waits…" / "Model and permission mode changes wait…"; null when nothing waits. */
export function queuedSettingsMessage(actions: readonly string[]): string | null {
  const names = [...new Set(actions.map((action) => SETTING_NAMES[action] ?? "setting"))];
  if (names.length === 0) return null;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const subject = capitalize(list);
  return names.length === 1
    ? `${subject} change waits for the backend to reconnect.`
    : `${subject} changes wait for the backend to reconnect.`;
}

/**
 * A setting changed while the backend was unreachable waits to be sent. The
 * controls keep showing the confirmed value (no optimistic update); this
 * read-out says the change is pending until the reconnect sends it. It takes
 * the session id as a prop, not from the composer context, which changes
 * while the agent streams.
 */
export const QueuedSettingsHint = memo(function QueuedSettingsHint({
  wsSessionId,
}: {
  wsSessionId: string | undefined;
}): ReactElement | null {
  const actions = useWsSessionStore((s) =>
    wsSessionId == null
      ? NO_ACTIONS
      : (s.sessions[wsSessionId]?.queuedCommandActions ?? NO_ACTIONS),
  );
  const message = queuedSettingsMessage(actions);
  if (message === null) return null;
  return (
    <span
      role="status"
      title={message}
      className="composer-instrument gap-1.5 text-muted-foreground"
    >
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      <span className="@max-[34rem]:hidden">Waiting to apply</span>
      <span className="sr-only">{message}</span>
    </span>
  );
});
