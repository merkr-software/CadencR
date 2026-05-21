import { useCallback } from "react";
import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import { nextProviderMode } from "@/lib/provider-modes";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { PermissionMode } from "@/types/permission-mode";

export const EMPTY_PROVIDER_MODES: readonly RuntimeProviderModeOption[] = [];

/**
 * Returns a handler that advances the session's permission mode through the
 * cycle of provider-specific modes plus the user's opt-in modes. Read from the
 * store inside the callback so we don't subscribe the consumer to every
 * session mutation.
 */
export function usePermissionModeToggle(
  sessionId: string,
  activeProviderId: string,
  enabledOptInModes: PermissionMode[],
  providerModes: readonly RuntimeProviderModeOption[],
): () => void {
  return useCallback((): void => {
    const store = useWsSessionStore.getState();
    const session = store.sessions[sessionId];
    if (!session) return;
    const next = nextProviderMode(
      activeProviderId,
      session.permissionMode,
      enabledOptInModes,
      providerModes ?? [],
    );
    if (next !== session.permissionMode) store.setPermissionMode(sessionId, next);
  }, [activeProviderId, enabledOptInModes, providerModes, sessionId]);
}
