import { create } from "zustand";

/** A file `cadencr open` asked for, waiting for its conversation's workspace. */
export interface PendingCliFileOpen {
  featureId: number;
  /** Relative to the conversation's editor root. */
  relativePath: string;
  line?: number;
}

/**
 * How long a request waits for its workspace. The navigation that follows it
 * mounts the workspace within moments; one that never came (another
 * navigation won) must not open the file whenever that conversation is
 * visited later.
 */
const PENDING_TTL_MS = 30_000;

interface CliFileOpenState {
  pending: (PendingCliFileOpen & { at: number }) | null;
  request: (open: PendingCliFileOpen) => void;
  /** Hands the pending open to `featureId`'s workspace, once, while it is fresh. */
  take: (featureId: number, now?: number) => PendingCliFileOpen | null;
}

export const useCliFileOpenStore = create<CliFileOpenState>((set, get) => ({
  pending: null,
  request: (open) => set({ pending: { ...open, at: Date.now() } }),
  take: (featureId, now = Date.now()) => {
    const { pending } = get();
    if (pending?.featureId !== featureId) return null;
    set({ pending: null });
    if (now - pending.at > PENDING_TTL_MS) return null;
    const { at: _at, ...open } = pending;
    return open;
  },
}));
