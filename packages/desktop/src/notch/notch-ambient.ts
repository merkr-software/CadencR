import type { NotchAgent } from "@/shared/notch";

/** Slots in the compact ear's row; sized against `.compact-dots` / `.compact-count` in notch.css. */
const MAX_COMPACT_DOTS = 4;

/**
 * The agents that keep the closed island out beside the notch: one at work,
 * one waiting on you, or a finished one whose reply you haven't read. A read,
 * finished agent stays in the hover list but no longer holds the island open.
 */
export function ambientAgents(agents: readonly NotchAgent[]): NotchAgent[] {
  return agents.filter((agent) => agent.status !== "done" || agent.unread);
}

/**
 * One dot per agent while they fit; past that a "+N" count takes the place of
 * the last dots — one dot per digit, so the row never outgrows the ear.
 */
export function compactDots(agents: readonly NotchAgent[]): {
  shown: readonly NotchAgent[];
  extra: number;
} {
  if (agents.length <= MAX_COMPACT_DOTS) return { shown: agents, extra: 0 };
  let visible = MAX_COMPACT_DOTS - 1;
  while (visible > 1 && visible + String(agents.length - visible).length > MAX_COMPACT_DOTS) {
    visible -= 1;
  }
  return { shown: agents.slice(0, visible), extra: agents.length - visible };
}
