import { create } from "zustand";

import type { FeatureLayoutState } from "./feature-layout-schema";

/**
 * Render-facing state of the auto layout mode, keyed by layout feature id.
 * The policy itself lives in `lib/auto-layout/`; this store only holds what
 * the UI draws: the toggle's confirmation pulse, the pane to animate in, the
 * undo snapshot, and whether the agent is driving the browser right now.
 */

export type AutoRevealKind = "activated" | "moved" | "split";

interface RevealedPane {
  paneId: string;
  kind: AutoRevealKind;
}

interface AutoLayoutStore {
  /**
   * When auto layout last restructured the layout (epoch ms); keys the
   * toggle's pulse. A time, not a counter: the restructure itself remounts the
   * toggle, so it can only tell a fresh pulse from a stale one by its age.
   */
  pulsedAt: Record<number, number>;
  /** Pane auto layout just revealed, until its entrance animation ends. */
  revealed: Record<number, RevealedPane>;
  /** Layout before the last auto restructure, while it can still be undone. */
  undo: Record<number, FeatureLayoutState>;
  /** Features whose agent drove the browser within the last few seconds. */
  agentBrowserActive: Record<number, true>;
  recordReveal(featureId: number, before: FeatureLayoutState, pane: RevealedPane): void;
  clearRevealed(featureId: number, paneId: string): void;
  clearUndo(featureId: number): void;
  setAgentBrowserActive(featureId: number, active: boolean): void;
}

function without<T>(record: Record<number, T>, key: number): Record<number, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const useAutoLayoutStore = create<AutoLayoutStore>((set) => ({
  pulsedAt: {},
  revealed: {},
  undo: {},
  agentBrowserActive: {},

  recordReveal: (featureId, before, pane) =>
    set((s) => {
      const restructured = pane.kind !== "activated";
      return {
        revealed: { ...s.revealed, [featureId]: pane },
        pulsedAt: restructured ? { ...s.pulsedAt, [featureId]: Date.now() } : s.pulsedAt,
        undo: restructured ? { ...s.undo, [featureId]: before } : s.undo,
      };
    }),

  clearRevealed: (featureId, paneId) =>
    set((s) =>
      s.revealed[featureId]?.paneId === paneId ? { revealed: without(s.revealed, featureId) } : s,
    ),

  clearUndo: (featureId) =>
    set((s) => (featureId in s.undo ? { undo: without(s.undo, featureId) } : s)),

  setAgentBrowserActive: (featureId, active) =>
    set((s) => {
      if (Boolean(s.agentBrowserActive[featureId]) === active) return s;
      return {
        agentBrowserActive: active
          ? { ...s.agentBrowserActive, [featureId]: true }
          : without(s.agentBrowserActive, featureId),
      };
    }),
}));
