import type { LiveAgentStatus } from "@/types/agent";

/**
 * What a conversation asks of the user, highest priority first: a pending
 * request, a failed turn not yet seen, an agent at work, a finished reply not
 * yet read, nothing.
 */
export type AttentionState = "waiting" | "failed" | "working" | "unread" | "idle";

export interface Attention {
  state: AttentionState;
  /** The conversation the state comes from: the row itself or a hidden child. */
  sourceFeatureId: number;
}

/** What a conversation has unseen; a failure outranks an unread reply. */
export type FeatureMark = "none" | "unread" | "failed";

export interface FeatureAttentionInput {
  featureId: number;
  status: LiveAgentStatus;
  /** An unread reply, or a failed turn nobody has opened since. */
  mark: FeatureMark;
}

const RANK: Record<AttentionState, number> = {
  waiting: 4,
  failed: 3,
  working: 2,
  unread: 1,
  idle: 0,
};

/** How each state reads in a label: the rail's tooltips, the status lens's headers. */
export const ATTENTION_LABEL: Record<AttentionState, string> = {
  waiting: "Waiting on you",
  failed: "Failed",
  working: "Working",
  unread: "Unread",
  idle: "Idle",
};

/** Whether `a` is more urgent than `b`: the one a collapsed parent shows. */
export function outranks(a: AttentionState, b: AttentionState): boolean {
  return RANK[a] > RANK[b];
}

/** Sort comparator: the more urgent state first. */
export function compareAttention(a: AttentionState, b: AttentionState): number {
  return RANK[b] - RANK[a];
}

/** Strong states ask for an action (answer, look at the error); quiet ones only inform. */
export function isStrongAttention(state: AttentionState): boolean {
  return state === "waiting" || state === "failed";
}

/** Whether the user has something to do or read there: anything but an agent at work. */
export function needsUser(state: AttentionState): boolean {
  return state !== "working" && state !== "idle";
}

function attentionState({ status, mark }: FeatureAttentionInput): AttentionState {
  if (status === "question") return "waiting";
  if (mark === "failed") return "failed";
  if (status === "agent") return "working";
  return mark === "unread" ? "unread" : "idle";
}

/**
 * The one place the sidebar decides what a conversation needs, so a row, its
 * collapsed parent and any later surface can never disagree. `hidden` are the
 * conversations folded under the row (a collapsed subtree): the most urgent
 * state wins, the row itself on a tie.
 */
export function deriveAttention(
  row: FeatureAttentionInput,
  hidden: readonly FeatureAttentionInput[] = [],
): Attention {
  let best: Attention = { state: attentionState(row), sourceFeatureId: row.featureId };
  for (const input of hidden) {
    const state = attentionState(input);
    if (outranks(state, best.state)) best = { state, sourceFeatureId: input.featureId };
  }
  return best;
}
