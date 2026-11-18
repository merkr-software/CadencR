import type { DisplayRowMode } from "@/types/agent-stream";
import { applyPersistedState, loadOlderSessionMessages } from "./ws-session-actions";
import type { StoreAccessors } from "./ws-envelope-handler";
import { loadSessionPromptTurn } from "./ws-session-prompt-turn";
import { resyncMessagesOnReconnect } from "./ws-session-resync";
import type { PersistedStatePayload, ResyncTarget, WsSessionStore } from "./ws-session-types";
import { updateSession } from "./ws-session-types";

type HistoryActions = Pick<
  WsSessionStore,
  | "markPersistedLoaded"
  | "failPersistedLoad"
  | "retryPersistedLoad"
  | "setPersistedState"
  | "loadOlderMessages"
  | "loadPromptTurn"
  | "refreshSessionMessages"
>;

/** Loading the saved conversation: the first snapshot, older pages, resyncs. */
export function createHistoryActions(ctx: StoreAccessors): HistoryActions {
  const { get, set } = ctx;
  return {
    markPersistedLoaded(sessionId: string) {
      set(updateSession(get(), sessionId, { persistedLoaded: true, historyLoadFailure: null }));
    },

    failPersistedLoad(sessionId: string, message: string) {
      set(
        updateSession(get(), sessionId, {
          persistedLoaded: true,
          historyLoadFailure: { message, retrying: false },
        }),
      );
    },

    retryPersistedLoad(sessionId: string) {
      const failure = get().sessions[sessionId]?.historyLoadFailure;
      if (!failure || failure.retrying) return;
      set(
        updateSession(get(), sessionId, {
          persistedLoaded: false,
          historyLoadFailure: { ...failure, retrying: true },
        }),
      );
    },

    setPersistedState(sessionId: string, payload: PersistedStatePayload) {
      applyPersistedState(ctx, sessionId, payload);
    },

    async loadOlderMessages(sessionId: string, displayMode?: DisplayRowMode): Promise<number> {
      return loadOlderSessionMessages(ctx, sessionId, displayMode);
    },

    loadPromptTurn(
      sessionId: string,
      messageDbId: number,
      displayMode?: DisplayRowMode,
    ): Promise<boolean> {
      return loadSessionPromptTurn(ctx, sessionId, messageDbId, displayMode);
    },

    refreshSessionMessages(sessionId: string, target?: ResyncTarget): Promise<void> {
      return resyncMessagesOnReconnect(ctx, sessionId, target);
    },
  };
}
