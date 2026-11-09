import { create } from "zustand";

/**
 * UI-only: which archived conversation's cleanup the review dialog shows.
 * Opened from a cleanup notice or an archived row's menu; the dialog renders
 * once from `RootOverlays`. The cleanup itself is read from the service.
 */
interface ArchiveCleanupReviewState {
  featureId: number | null;
  open: (featureId: number) => void;
  close: () => void;
}

export const useArchiveCleanupReviewStore = create<ArchiveCleanupReviewState>((set) => ({
  featureId: null,
  open: (featureId) => set({ featureId }),
  close: () => set({ featureId: null }),
}));
