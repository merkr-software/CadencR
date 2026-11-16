/**
 * Which of a conversation's pull requests the Git tab's PR pane shows, per
 * conversation. Absent means the current branch's — the default, and what the
 * pane falls back to when the picked one leaves the conversation.
 *
 * View state only: it never describes the forge, so it is not subject to the
 * backend-confirms rule the status stores follow.
 */
import { create } from "zustand";

interface ViewedPrState {
  byFeature: Record<number, number>;
  /** `null` goes back to the current branch's pull request. */
  setViewedPr: (featureId: number, prNumber: number | null) => void;
}

export const useViewedPrStore = create<ViewedPrState>((set) => ({
  byFeature: {},
  setViewedPr(featureId, prNumber) {
    set((state) => {
      if (prNumber == null) {
        if (!(featureId in state.byFeature)) return state;
        const { [featureId]: _dropped, ...rest } = state.byFeature;
        return { byFeature: rest };
      }
      if (state.byFeature[featureId] === prNumber) return state;
      return { byFeature: { ...state.byFeature, [featureId]: prNumber } };
    });
  },
}));

export function selectViewedPr(featureId: number) {
  return (state: ViewedPrState): number | undefined => state.byFeature[featureId];
}
