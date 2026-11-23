import { useWsSessionStore } from "@/stores/ws-session-store";

/**
 * Whether a session command is sent or waiting for a reconnect and not yet
 * answered: one kind (`interrupt`, `model.set`, …) or any of several.
 */
export function useSessionCommandPending(
  wsSessionId: string | undefined,
  kinds: string | readonly string[],
): boolean {
  return useWsSessionStore((s) => {
    const pending = wsSessionId == null ? undefined : s.sessions[wsSessionId];
    if (!pending) return false;
    return typeof kinds === "string"
      ? pending.pendingCommandActions.includes(kinds)
      : pending.pendingCommandActions.some((kind) => kinds.includes(kind));
  });
}
