import { preloadableChunk } from "./lazy-chunk";

/**
 * The conversation view (the transcript, the composer and everything they
 * render: the largest part of the renderer) in its own chunk. Outside the
 * phone layout `main.tsx` waits for it at boot, so the conversation's first
 * commit is the real one (its prompt can take focus on mount). The phone
 * layout opens on the Agents inbox, which paints without it: the inbox fetches
 * it once idle and a press on a conversation at once (`prefetchAgentSession`).
 * Render `LazyAgentSession` under a `LazyBoundary`.
 */
const agentSessionChunk = preloadableChunk(() =>
  import("@/components/agent-session/AgentSession").then((module) => module.AgentSession),
);

export const preloadAgentSession = agentSessionChunk.preload;
export const prefetchAgentSession = agentSessionChunk.prefetch;
export const LazyAgentSession = agentSessionChunk.Component;
