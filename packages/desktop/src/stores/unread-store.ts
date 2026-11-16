/**
 * Tracks which features have something the user has not seen yet:
 * - unread: the agent finished its turn (agent → idle) while the user was NOT
 *   viewing that feature, or the user marked it unread by hand;
 * - failed: the turn stopped on an error while nobody was looking.
 * The sidebar renders a green check for unread and a strong error mark for
 * failed; both clear the moment the conversation is opened, unless "For me
 * clears" is "When done": then only marking it done (the For me row's check,
 * the shortcut) or sending it a prompt does (`acknowledgeForMe`).
 *
 * It also remembers the pull request actions marked done (`prAcks`), so a
 * dismissed "Fix CI" or "Merge" stays out of For me until the pull request
 * moves.
 *
 * Per-client by design — "unread" is relative to *this* window (a remote phone
 * and the host each track their own), so nothing goes to the backend. The
 * marks, their order and the dismissed actions are kept in localStorage
 * (`unread-marks-storage.ts`) so a reload or a restart keeps every pending
 * "review this" and "this failed" instead of silently dropping them from the
 * For me list.
 *
 * Conforms to frontend-performance.md: consumers read the per-feature boolean
 * via `useIsFeatureUnread`, never the whole map.
 */
import { create } from "zustand";
import type { FeatureMark } from "@/lib/sidebar-attention";
import { loadUnreadMarks, saveUnreadMarks, type UnreadMarks } from "./unread-marks-storage";

/** `markedOrder` drives the "For me" block, which lists the oldest mark first. */
interface UnreadState extends UnreadMarks {
  /** Flag a completed-but-unviewed agent turn (or a hand-marked conversation). */
  markUnread: (featureId: number) => void;
  /** Flag a failed-but-unviewed agent turn. */
  markFailed: (featureId: number) => void;
  /** Drop the failure flag once the conversation works again. */
  clearFailed: (featureId: number) => void;
  /** Clear every flag for a feature (e.g. when its conversation opens). */
  markRead: (featureId: number) => void;
  /** Mark as read when flagged, as unread otherwise (the row's menu and shortcut). */
  toggleMarked: (featureId: number) => void;
  /**
   * The user is done with the conversation's For me entry: read it, and
   * dismiss its pull request action (`prKey`, null when it asks none).
   */
  acknowledge: (featureId: number, prKey: string | null) => void;
  /** Drop everything kept about a conversation that was archived or deleted. */
  forget: (featureId: number) => void;
}

type MarkFlags = Pick<UnreadState, "byFeature" | "failedByFeature">;

export function featureMark(state: MarkFlags, featureId: number): FeatureMark {
  if (state.failedByFeature[featureId]) return "failed";
  return state.byFeature[featureId] ? "unread" : "none";
}

const restored = loadUnreadMarks();

/** Continues after the restored marks, so a new mark sorts after every one of them. */
let nextMark = Object.keys(restored.markedOrder).length;

function withOrder(order: Record<number, number>, featureId: number): Record<number, number> {
  return featureId in order ? order : { ...order, [featureId]: ++nextMark };
}

function without<T>(record: Record<number, T>, featureId: number): Record<number, T> {
  if (!(featureId in record)) return record;
  const next = { ...record };
  delete next[featureId];
  return next;
}

type Marks = Pick<UnreadState, "byFeature" | "failedByFeature" | "markedOrder">;

/** The marks once a conversation is read; `state` itself when it had none. */
function read<S extends Marks>(state: S, featureId: number): S | Marks {
  if (!state.byFeature[featureId] && !state.failedByFeature[featureId]) return state;
  return {
    byFeature: without(state.byFeature, featureId),
    failedByFeature: without(state.failedByFeature, featureId),
    markedOrder: without(state.markedOrder, featureId),
  };
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  ...restored,
  markUnread: (featureId) =>
    set((s) =>
      s.byFeature[featureId]
        ? s
        : {
            byFeature: { ...s.byFeature, [featureId]: true },
            markedOrder: withOrder(s.markedOrder, featureId),
          },
    ),
  markFailed: (featureId) =>
    set((s) =>
      s.failedByFeature[featureId]
        ? s
        : {
            failedByFeature: { ...s.failedByFeature, [featureId]: true },
            markedOrder: withOrder(s.markedOrder, featureId),
          },
    ),
  clearFailed: (featureId) =>
    set((s) => {
      if (!s.failedByFeature[featureId]) return s;
      return {
        failedByFeature: without(s.failedByFeature, featureId),
        markedOrder: s.byFeature[featureId] ? s.markedOrder : without(s.markedOrder, featureId),
      };
    }),
  markRead: (featureId) => set((s) => read(s, featureId)),
  toggleMarked: (featureId) => {
    const state = get();
    if (featureMark(state, featureId) === "none") state.markUnread(featureId);
    else state.markRead(featureId);
  },
  acknowledge: (featureId, prKey) =>
    set((s) => {
      const next = read(s, featureId);
      if (prKey === null || s.prAcks[featureId] === prKey) return next;
      return { ...next, prAcks: { ...s.prAcks, [featureId]: prKey } };
    }),
  forget: (featureId) =>
    set((s) => {
      const next = read(s, featureId);
      return featureId in s.prAcks ? { ...next, prAcks: without(s.prAcks, featureId) } : next;
    }),
}));

useUnreadStore.subscribe((state, previous) => {
  if (
    state.byFeature === previous.byFeature &&
    state.failedByFeature === previous.failedByFeature &&
    state.markedOrder === previous.markedOrder &&
    state.prAcks === previous.prAcks
  ) {
    return;
  }
  saveUnreadMarks(state);
});

/**
 * Narrow per-feature subscription: re-renders the consumer only when *this*
 * feature's unread flag flips — safe to call in the memoized sidebar row.
 */
export function useIsFeatureUnread(featureId: number): boolean {
  return useUnreadStore((s) => s.byFeature[featureId] === true);
}

/** Whether the feature has an unread reply or an unseen failure. */
export function useIsFeatureMarked(featureId: number): boolean {
  return useUnreadStore((s) => featureMark(s, featureId) !== "none");
}
