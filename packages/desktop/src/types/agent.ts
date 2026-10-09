/**
 * Shared agent types used across renderer components and hooks.
 *
 * Two distinct status concepts coexist on the frontend:
 *
 * - [`LiveAgentStatus`] — the canonical 3-value enum pushed by the
 *   backend on `app/session_status.*` envelopes (mirrors the Rust
 *   `AgentStatus` in `domain::session_status`). This is the SINGLE
 *   source of truth for the UI badge / sidebar provider mark / input-bar
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

import type { UserMessageDeliveryState } from "@/api/generated";

export type LiveAgentStatus = "idle" | "agent" | "question";

export type AgentStatus = "idle" | "running" | "completed" | "error" | "paused" | "waiting";

export type PendingKind = "permission" | "question";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export type PromptDeliveryState = UserMessageDeliveryState;

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

const UNKNOWN_CONTEXT_USAGE: ContextUsageState = {
  inputTokens: 0,
  outputTokens: 0,
  contextWindow: null,
  wasCompacted: false,
};

/**
 * The usage the context meter should render, or `null` to hide it.
 * Provider-neutral: a window no provider has reported yet (Claude Code only
 * sends it when a turn ends; Cursor never does) shows as "unknown" while the
 * agent works — even before any usage arrived — or once tokens were spent.
 */
export function contextUsageToShow(
  usage: ContextUsageState | null | undefined,
  isAgentWorking: boolean,
): ContextUsageState | null {
  if (!usage) return isAgentWorking ? UNKNOWN_CONTEXT_USAGE : null;
  const hasSomethingToSay =
    isAgentWorking || totalTokens(usage) > 0 || normalizeContextWindow(usage.contextWindow) != null;
  return hasSomethingToSay ? usage : null;
}

/** Share of the window in use, or `null` while the window is unknown. */
export function usageRatio(usage: ContextUsageState): number | null {
  const windowSize = normalizeContextWindow(usage.contextWindow);
  return windowSize == null ? null : Math.min(1, totalTokens(usage) / windowSize);
}
