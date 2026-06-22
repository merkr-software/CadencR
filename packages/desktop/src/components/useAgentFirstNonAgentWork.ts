import { useEffect, useMemo, useState } from "react";
import type { TabKind } from "@/stores/feature-layout-schema";

export const AGENT_FIRST_NON_AGENT_WORK_DELAY_MS = 1_200;

interface DeferredWorkState {
  resetKey: string;
  ready: boolean;
}

interface UseAgentFirstNonAgentWorkOptions {
  enabled: boolean;
  immediate: boolean;
  resetKey: string;
}

export function useAgentFirstNonAgentWork({
  enabled,
  immediate,
  resetKey,
}: UseAgentFirstNonAgentWorkOptions): boolean {
  const [state, setState] = useState<DeferredWorkState>(() => ({
    resetKey,
    ready: false,
  }));

  useEffect((): (() => void) | void => {
    setState((current) => {
      if (current.resetKey !== resetKey) return { resetKey, ready: immediate };
      return immediate && !current.ready ? { resetKey, ready: true } : current;
    });
    if (!enabled || immediate) return undefined;

    const timer = window.setTimeout(() => {
      setState((current) => (current.resetKey === resetKey ? { resetKey, ready: true } : current));
    }, AGENT_FIRST_NON_AGENT_WORK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, immediate, resetKey]);

  const timerReadyForCurrentSession = state.resetKey === resetKey && state.ready;
  return enabled && (immediate || timerReadyForCurrentSession);
}

/**
 * Priority order in which non-agent tabs are progressively enabled once the
 * agent has painted. Editor first, then git, terminal, browser — the order the
 * user is most likely watching for in a split layout, and it staggers the
 * expensive panels (editor/diff) so no single frame hydrates two at once.
 */
const STAGGER_ORDER: readonly Exclude<TabKind, "agent">[] = [
  "editor",
  "git",
  "terminal",
  "browser",
];
/** Gap between revealing each successive tab. */
const STAGGER_STEP_MS = 120;

export type NonAgentTabReadiness = Record<Exclude<TabKind, "agent">, boolean>;

interface StaggerState {
  resetKey: string;
  stage: number;
}

interface UseStaggeredTabReadinessOptions {
  /** Gate signal — non-agent work may begin (the agent has painted). */
  enabled: boolean;
  /** A non-agent tab the user explicitly focused/requested; ready instantly. */
  immediateTab: TabKind | null;
  /** Resets the stagger when the conversation changes. */
  resetKey: string;
}

/**
 * Reveal non-agent tab content in priority order rather than all at once.
 *
 * Only *visible* tabs ever mount (the layout shell mounts inactive tabs
 * lazily), so this staggering matters in split layouts where several non-agent
 * tabs are visible alongside the agent on open: instead of every panel
 * hydrating in the same frame and competing with the agent stream, they come
 * online one at a time. The tab the user explicitly opened is exempt — it
 * loads the moment the gate opens.
 */
export function useStaggeredTabReadiness({
  enabled,
  immediateTab,
  resetKey,
}: UseStaggeredTabReadinessOptions): NonAgentTabReadiness {
  // `stage` = number of STAGGER_ORDER tabs revealed so far. Pairing it with the
  // resetKey *in state* (rather than a ref) lets us discard a previous
  // conversation's stage synchronously on switch — see the gate below — so no
  // tab is reported ready for the new conversation for even a single frame.
  const [state, setState] = useState<StaggerState>(() => ({ resetKey, stage: 0 }));

  useEffect((): (() => void) | void => {
    setState((current) => (current.resetKey === resetKey ? current : { resetKey, stage: 0 }));
    if (!enabled) return undefined;

    let cancelled = false;
    const timers = STAGGER_ORDER.map((_, index) =>
      window.setTimeout(
        () => {
          if (cancelled) return;
          setState((current) =>
            current.resetKey === resetKey
              ? { resetKey, stage: Math.max(current.stage, index + 1) }
              : current,
          );
        },
        (index + 1) * STAGGER_STEP_MS,
      ),
    );
    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [enabled, resetKey]);

  const stage = state.resetKey === resetKey ? state.stage : 0;

  return useMemo<NonAgentTabReadiness>(() => {
    const ready = (kind: Exclude<TabKind, "agent">, index: number): boolean =>
      enabled && (kind === immediateTab || stage > index);
    return {
      editor: ready("editor", 0),
      git: ready("git", 1),
      terminal: ready("terminal", 2),
      browser: ready("browser", 3),
    };
  }, [enabled, immediateTab, stage]);
}
