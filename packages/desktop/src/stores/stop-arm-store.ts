import { create } from "zustand";
import { composerKeyFor } from "./composer-context-store";

/** How long the first Esc keeps "stop" armed before it lapses. */
export const STOP_ARM_WINDOW_MS = 1600;

interface StopArmState {
  /** Composer (session key) whose next Esc stops the agent, or null. */
  armedKey: string | null;
  arm: (key: string) => void;
  disarm: () => void;
}

let lapseTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Stop is a two-press gesture: Esc is the universal "close / back out" key, so
 * a single press must never kill a running turn. The first press arms stop and
 * surfaces a hint; a second press inside the window confirms it.
 */
export const useStopArmStore = create<StopArmState>((set) => ({
  armedKey: null,
  arm: (key) => {
    clearTimeout(lapseTimer);
    lapseTimer = setTimeout(() => set({ armedKey: null }), STOP_ARM_WINDOW_MS);
    set({ armedKey: key });
  },
  disarm: () => {
    clearTimeout(lapseTimer);
    set({ armedKey: null });
  },
}));

/** The arm key of one composer: its live session, else its conversation. */
export function stopArmKeyFor(wsSessionId: string | undefined, featureId: number | undefined) {
  return wsSessionId ?? composerKeyFor(featureId);
}
