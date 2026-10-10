import { useAutoLayoutStore, type AutoRevealKind } from "@/stores/auto-layout-store";
import type { TabKind } from "@/stores/feature-layout-schema";
import { choosePlacement, planReveal } from "@/stores/feature-layout-reveal";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";

/**
 * Runtime half of the auto layout mode: decides *whether* a reveal may happen
 * (mode, user-intent guards) and applies the pure `planReveal` result.
 *
 * Only a mounted feature page with splits enabled registers a target, so
 * mobile, Unified Agents cards, and features that aren't on screen never get
 * their layout rearranged from afar.
 */

export type RevealSource = "user-link" | "agent";

/** A mounted feature layout shell with auto layout on. */
interface AutoLayoutTarget {
  /** Current size of the feature's layout shell, or null if unmeasurable. */
  measure: () => { width: number; height: number } | null;
}

/**
 * A manual layout change holds off agent-driven reveals this long, so the
 * agent never yanks a pane the user is arranging.
 */
const USER_INTENT_COOLDOWN_MS = 8_000;

const targets = new Map<number, AutoLayoutTarget>();
const lastUserLayoutChangeAt = new Map<number, number>();
/** Features whose agent already got its one reveal for the current turn. */
const agentRevealSpent = new Set<number>();

export function registerAutoLayoutTarget(featureId: number, target: AutoLayoutTarget): () => void {
  targets.set(featureId, target);
  return () => {
    if (targets.get(featureId) === target) targets.delete(featureId);
  };
}

/**
 * What a reveal request came to:
 *  - `declined`: auto layout didn't take it (off, not mounted, no room to
 *    split), so the caller applies its manual-mode behaviour instead
 *  - `held`: an agent request swallowed by the user-intent guards
 *  - `noop`: the tab was already showing
 *  - otherwise the change auto layout just made
 */
export type AutoRevealOutcome = "declined" | "held" | "noop" | AutoRevealKind;

/** Reveal `tab` for `featureId` if auto layout is on. */
export function requestAutoReveal(
  featureId: number,
  tab: TabKind,
  source: RevealSource,
): AutoRevealOutcome {
  const target = targets.get(featureId);
  if (!target) return "declined";
  if (source === "agent" && !agentMayReveal(featureId)) return "held";

  const before = useFeatureLayoutStore.getState().features[featureId];
  if (!before) return "declined";
  const result = planReveal(before, tab, {
    placement: choosePlacement(target.measure()),
    focus: source === "user-link",
  });
  if (result.kind === "blocked") return "declined";
  // Whatever happened, the agent has had its say this turn: if the user hides
  // the tab again, a later agent action in the same turn must not undo that.
  if (source === "agent") agentRevealSpent.add(featureId);
  if (result.kind === "noop") return "noop";

  useFeatureLayoutStore.getState().setState(featureId, result.state);
  useAutoLayoutStore
    .getState()
    .recordReveal(featureId, before, { paneId: result.paneId, kind: result.kind });
  return result.kind;
}

function agentMayReveal(featureId: number): boolean {
  if (agentRevealSpent.has(featureId)) return false;
  const lastChange = lastUserLayoutChangeAt.get(featureId);
  return lastChange === undefined || Date.now() - lastChange >= USER_INTENT_COOLDOWN_MS;
}

/**
 * Record a manual layout gesture. Structural changes (moving/docking tabs,
 * applying or resetting a layout) also drop the undo snapshot, which would
 * otherwise silently discard the user's own rearrangement.
 */
export function noteUserLayoutChange(featureId: number, { structural = false } = {}): void {
  lastUserLayoutChangeAt.set(featureId, Date.now());
  if (structural) useAutoLayoutStore.getState().clearUndo(featureId);
}

/** A new user prompt starts a new turn: the agent may reveal once more. */
export function noteUserPrompt(featureId: number): void {
  agentRevealSpent.delete(featureId);
}

/** Restore the layout from before the last auto restructure. */
export function undoAutoLayout(featureId: number): void {
  const before = useAutoLayoutStore.getState().undo[featureId];
  if (!before) return;
  const current = useFeatureLayoutStore.getState().features[featureId];
  // Keep the size memory learned since — undo is about panes, not preferences.
  useFeatureLayoutStore
    .getState()
    .setState(featureId, { ...before, autoShares: current?.autoShares ?? before.autoShares });
  useAutoLayoutStore.getState().clearUndo(featureId);
  // Undoing is a clear "not now": the agent shouldn't redo it this turn.
  agentRevealSpent.add(featureId);
}

/** Test-only: forget all registrations and guard state. */
export function resetAutoLayoutControllerForTests(): void {
  targets.clear();
  lastUserLayoutChangeAt.clear();
  agentRevealSpent.clear();
}
