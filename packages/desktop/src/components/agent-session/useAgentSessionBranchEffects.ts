import { useEffect, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { navigateToFeatureIdOrHome } from "../project-feature-navigation";
import type { AgentPromptBarHandle } from "../AgentPromptBar";

/**
 * One-shot reactions to Rewind & Fork store signals scoped to this session:
 *
 * - **composerPrefill** — a rewound/forked draft to drop into the composer.
 * - **forkNavigation** — navigate this (source) client to the just-created fork.
 *
 * Each signal is consumed after firing so it runs exactly once. Both selectors
 * are session-scoped so an unrelated session's signal never wakes this hook.
 */
export function useAgentSessionBranchEffects(
  wsSessionId: string | undefined,
  promptBarRef: RefObject<AgentPromptBarHandle | null>,
): void {
  const navigate = useNavigate();

  const composerPrefill = useWsSessionStore((s) =>
    s.composerPrefill?.sessionId === wsSessionId ? s.composerPrefill : null,
  );
  const consumeComposerPrefill = useWsSessionStore((s) => s.consumeComposerPrefill);
  useEffect(() => {
    if (!wsSessionId || !composerPrefill) return;
    promptBarRef.current?.setDraft(composerPrefill.text);
    consumeComposerPrefill(wsSessionId);
  }, [composerPrefill, wsSessionId, consumeComposerPrefill, promptBarRef]);

  const forkNavigation = useWsSessionStore((s) =>
    s.forkNavigation?.sessionId === wsSessionId ? s.forkNavigation : null,
  );
  const consumeForkNavigation = useWsSessionStore((s) => s.consumeForkNavigation);
  useEffect(() => {
    if (!wsSessionId || !forkNavigation) return;
    navigateToFeatureIdOrHome(navigate, forkNavigation.projectId, forkNavigation.featureId);
    consumeForkNavigation(wsSessionId);
  }, [forkNavigation, wsSessionId, consumeForkNavigation, navigate]);
}
