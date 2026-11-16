import { create } from "zustand";

/**
 * Which document each feature's Preview tab shows, keyed by feature id (the
 * real one, not a Unified Agents card's layout id: the file is read through
 * that feature's editor root). Session-only — the Preview tab is a viewer,
 * and a stale path from a previous launch would only open on an error.
 */
interface DocumentPreviewStore {
  /** Project-relative path previewed per feature. */
  byFeature: Record<number, string>;
  open(featureId: number, filePath: string): void;
  close(featureId: number): void;
}

export const useDocumentPreviewStore = create<DocumentPreviewStore>((set) => ({
  byFeature: {},
  open: (featureId, filePath) =>
    set((state) =>
      state.byFeature[featureId] === filePath
        ? state
        : { byFeature: { ...state.byFeature, [featureId]: filePath } },
    ),
  close: (featureId) =>
    set((state) => {
      if (!(featureId in state.byFeature)) return state;
      const byFeature = { ...state.byFeature };
      delete byFeature[featureId];
      return { byFeature };
    }),
}));
