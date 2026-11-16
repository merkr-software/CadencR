import { useWsSessionStore } from "@/stores/ws-session-store";

/** Whether a session command (`interrupt`, `model.set`, …) is awaiting the backend. */
export function useSessionCommandPending(wsSessionId: string | undefined, action: string): boolean {
  return useWsSessionStore((s) =>
    wsSessionId == null
      ? false
      : (s.sessions[wsSessionId]?.pendingCommandActions.includes(action) ?? false),
  );
}
