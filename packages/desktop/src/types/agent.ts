/**
 * Shared agent types used across renderer components and hooks.
 *
 * Two distinct status concepts coexist on the frontend:
 *
 * - [`LiveAgentStatus`] — the canonical 3-value enum pushed by the
 *   backend on `app/session_status.*` envelopes (mirrors the Rust
 *   `AgentStatus` in `domain::session_status`). This is the SINGLE
 *   source of truth for the UI badge / sidebar icon / input-bar
 *   "disabled while working" check.
 *
 * - [`AgentStatus`] — the legacy 6-value lifecycle column read from the
 *   DB via REST. Workflow code uses this for resumability and
 *   "can-start" decisions (`is the agent already running?`,
 *   `did it error out?`, `is it complete?`). NOT a source of live
 *   status — go through the live store for that.
 *
 * Pending-input gate kinds are surfaced separately via `PendingKind`
 * so the UI can show permission / question labels alongside the
 * question icon.
 */

export type LiveAgentStatus = "idle" | "agent" | "question";

export type AgentStatus = "idle" | "running" | "completed" | "error" | "paused" | "waiting";

export type PendingKind = "permission" | "question";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export type PromptDeliveryState = "pending_agent" | "received_agent";

export interface ContextUsageState {
  inputTokens: number;
  outputTokens: number;
  /** `null` means the provider has not reported an authoritative window yet. */
  contextWindow: number | null;
  wasCompacted: boolean;
}

export function normalizeContextWindow(contextWindow: number | null | undefined): number | null {
  return contextWindow != null && contextWindow > 0 ? contextWindow : null;
}

export function totalTokens(usage: ContextUsageState): number {
  return usage.inputTokens + usage.outputTokens;
}

export function usageRatio(usage: ContextUsageState): number {
  if (!usage.contextWindow || usage.contextWindow <= 0) return 0;
  return Math.min(1, totalTokens(usage) / usage.contextWindow);
}
