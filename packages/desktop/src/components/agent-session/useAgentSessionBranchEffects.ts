import { useEffect, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useWorkspaceActivity, whileActive } from "@/components/workspace-pool/workspace-activity";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { navigateToConversation } from "@/lib/conversation-route";
import type { AgentPromptBarHandle } from "../AgentPromptBar";

/**
 * One-shot reactions to Rewind & Fork store signals scoped to this session:
 *
 * - **composerPrefill** — a rewound/forked draft to drop into the composer.
 * - **forkNavigation** — navigate this (source) client to the just-created fork,
 *   once this conversation is the one on screen; dropped if it goes first.
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
  // A fork that completes while its conversation is hidden (`WorkspacePool`)
  // must not carry the app away from the one on screen: it waits until its
  // conversation is shown again. The service just created the fork, so it is
  // opened straight in its workspace, the pool kept.
  const activity = useWorkspaceActivity();
  useEffect(() => {
    if (!wsSessionId || !forkNavigation) return undefined;
    return whileActive(activity, () => {
      navigateToConversation(navigate, forkNavigation.projectId, forkNavigation.featureId, {
        featureKnown: true,
      });
      consumeForkNavigation(wsSessionId);
      return () => {};
    });
  }, [activity, forkNavigation, wsSessionId, consumeForkNavigation, navigate]);
  // A workspace that goes (trimmed from the pool) with its navigation still
  // pending drops it: opening the conversation much later must not carry the
  // app away to a fork made long before.
  useEffect(
    () => () => {
      if (!wsSessionId) return;
      if (useWsSessionStore.getState().forkNavigation?.sessionId === wsSessionId) {
        consumeForkNavigation(wsSessionId);
      }
    },
    [wsSessionId, consumeForkNavigation],
  );
}
