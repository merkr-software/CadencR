/**
 * What the notch island remembers that no other store does: which agents
 * finished during this run (and when), and which of them the user cleared
 * from the island. Per-window and in-memory, like the unread set — a fresh
 * load has nothing recent to show.
 *
 * Live status is NOT here: it is read from `useSessionStatusStore`, the only
 * source of "is the agent working?".
 */
import { create } from "zustand";

interface NotchState {
  /** Feature → epoch ms its agent last went from working/blocked to idle. */
  finishedAt: Record<number, number>;
  /** Feature → epoch ms the user cleared it from the island. */
  dismissedAt: Record<number, number>;
  markFinished: (featureId: number, at: number) => void;
  dismiss: (featureId: number, at: number) => void;
}

export const useNotchStore = create<NotchState>((set) => ({
  finishedAt: {},
  dismissedAt: {},
  markFinished: (featureId, at) =>
    set((s) => ({ finishedAt: { ...s.finishedAt, [featureId]: at } })),
  dismiss: (featureId, at) => set((s) => ({ dismissedAt: { ...s.dismissedAt, [featureId]: at } })),
}));
