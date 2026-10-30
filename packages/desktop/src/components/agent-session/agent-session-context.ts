import { createContext, useContext } from "react";

/**
 * Identity of the agent session whose stream is being rendered, provided once
 * by `AgentSession` so deeply-nested, Virtuoso-recycled leaves (e.g. the
 * per-block context menu) can dispatch session-scoped actions without threading
 * the id through every prop. The value is stable per session, so consumers
 * memoized on it don't re-render during streaming.
 */
export interface AgentSessionContextValue {
  /** Store key for the session (`ws-feature-<id>`), or `null` outside a session. */
  wsSessionId: string | null;
  /** Feature whose conversation this is; scopes its sub-agent registry. */
  featureId: number | null;
  /**
   * Session actions for transcript affordances (Resume after a stop, an
   * error's recovery buttons). Identity-stable; no-ops outside a session.
   */
  sendPrompt: (text: string) => void;
  openModelPicker: () => void;
}

const noop = (): void => {};

const AgentSessionContext = createContext<AgentSessionContextValue>({
  wsSessionId: null,
  featureId: null,
  sendPrompt: noop,
  openModelPicker: noop,
});

export const AgentSessionProvider = AgentSessionContext.Provider;

export function useAgentSessionContext(): AgentSessionContextValue {
  return useContext(AgentSessionContext);
}
