import type { DisplayRowMode } from "@/types/agent-stream";
import { applyPersistedState } from "./ws-session-actions";
import type { HistoryGapFillDirection } from "./ws-history-gaps";
import { type FillHistoryGapOptions, fillSessionHistoryGap } from "./ws-session-history-fill";
import type { StoreAccessors } from "./ws-envelope-handler";
import { loadSessionPromptTurn } from "./ws-session-prompt-turn";
import { resyncMessagesOnReconnect } from "./ws-session-resync";
import type { PersistedStatePayload, ResyncTarget, WsSessionStore } from "./ws-session-types";
import { createSessionEntry, updateSession } from "./ws-session-types";

type HistoryActions = Pick<
  WsSessionStore,
  | "markPersistedLoaded"
  | "failPersistedLoad"
  | "retryPersistedLoad"
  | "setPersistedState"
  | "hydratePersistedState"
  | "fillHistoryGap"
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

    failPersistedLoad(sessionId, message) {
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
      if (failure.resyncSessionDbId !== undefined) {
        if (ctx.transport.get(sessionId)?.conn?.isOpen()) {
          void resyncMessagesOnReconnect(ctx, sessionId);
        }
        return;
      }
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

    hydratePersistedState(sessionId: string, snapshot: PersistedStatePayload | null) {
      if (!get().sessions[sessionId]) {
        set({ sessions: { ...get().sessions, [sessionId]: createSessionEntry() } });
      }
      if (snapshot) {
        applyPersistedState(ctx, sessionId, snapshot);
        return;
      }
      set(updateSession(get(), sessionId, { persistedLoaded: true, historyLoadFailure: null }));
    },

    fillHistoryGap(
      sessionId: string,
      gapId: string,
      direction: HistoryGapFillDirection,
      options?: FillHistoryGapOptions,
    ): Promise<void> {
      return fillSessionHistoryGap(ctx, sessionId, gapId, direction, options);
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
