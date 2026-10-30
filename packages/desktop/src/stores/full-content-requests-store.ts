import { create } from "zustand";

/**
 * Which truncated messages the user asked to see in full, owned outside the
 * stream rows.
 *
 * Loading a large message makes its row much taller, and Virtuoso answers that
 * jump by briefly rendering an empty range and remounting every row. A request
 * held in component state died with that remount, so "Show all" flashed the
 * full content and fell straight back to the preview. Each request remembers
 * the preview it was made against: a new preview (a content revision) is a new
 * message as far as the user is concerned and starts collapsed again.
 */
interface FullContentRequestsState {
  /** messageId → the preview shown when the full content was requested. */
  requests: ReadonlyMap<number, string>;
  request: (messageId: number, preview: string) => void;
  release: (messageId: number) => void;
}

export const useFullContentRequestsStore = create<FullContentRequestsState>((set) => ({
  requests: new Map(),
  request: (messageId, preview) =>
    set((state) => ({ requests: new Map(state.requests).set(messageId, preview) })),
  release: (messageId) =>
    set((state) => {
      if (!state.requests.has(messageId)) return state;
      const requests = new Map(state.requests);
      requests.delete(messageId);
      return { requests };
    }),
}));

/** The preview `messageId` was expanded against, if it was. */
export function useRequestedPreview(messageId: number | undefined): string | undefined {
  return useFullContentRequestsStore((state) =>
    messageId === undefined ? undefined : state.requests.get(messageId),
  );
}
