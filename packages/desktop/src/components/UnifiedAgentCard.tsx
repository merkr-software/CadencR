import { memo, useCallback, useLayoutEffect, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { UnifiedAgentEntry } from "@/api/generated";
import { useUnifiedAgentPinControls } from "@/components/useUnifiedAgentPinControls";
import { WebSocketSessionFeatureBlock } from "@/components/WebSocketSessionFeatureBlock";
import { ResolvedModelProvider } from "@/contexts/ResolvedModelContext";
import { useFeaturePrefetch } from "@/hooks/useFeaturePrefetch";
import { useShortcut } from "@/hooks/useShortcut";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { cn } from "@/lib/utils";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry, type SessionEntry } from "@/stores/ws-session-types";
import { persistedSessionToLifecycle, type TurnLifecycle } from "@/stores/ws-turn-lifecycle";
import { normalizeContextWindow } from "@/types/agent";
import type { ContextUsageState } from "@/types/agent";
import { parsePermissionMode } from "@/types/permission-mode";
import { parseCodexPermissionMode } from "@/types/codex-permission-mode";
import type { AgentQuestion } from "@/components/AgentQuestionDrawer";
import type { PendingPermission } from "@/components/ToolPermissionPrompt";

type WsSessionState = ReturnType<(typeof useWsSessionStore)["getState"]>;
type PersistedSnapshot = Parameters<WsSessionState["setPersistedState"]>[1];

interface UnifiedAgentCardProps {
  entry: UnifiedAgentEntry;
  index: number;
  isActive: boolean;
  onActivate: (index: number) => void;
  onExcludeAgent: (title: string) => void;
}

export const UnifiedAgentCard = memo(function UnifiedAgentCard({
  entry,
  index,
  isActive,
  onActivate,
  onExcludeAgent,
}: UnifiedAgentCardProps): ReactElement {
  useHydrateUnifiedWsSession(entry);
  const pinControls = useUnifiedAgentPinControls(entry);
  const prefetchFeature = useFeaturePrefetch(entry.feature.id, entry.project.id);
  // Stable so the surrounding `React.memo` and the section's focus/pointer
  // handlers don't tear down every render while the grid streams updates.
  const activate = useCallback((): void => onActivate(index), [onActivate, index]);
  const excludeAgent = useCallback(
    (): void => onExcludeAgent(entry.feature.title),
    [onExcludeAgent, entry.feature.title],
  );
  // CMD+O on the active card opens its dedicated feature page. Gated on
  // `isActive` so only the focused card listens — the listener is bubble-
  // phase (@tanstack/react-hotkeys), and Cadencr doesn't bind CMD+O elsewhere
  // outside of a scoped drawer, so the active-card gate is the disambiguator.
  const navigate = useNavigate();
  useShortcut(
    "agents-open-feature",
    (event) => {
      event.preventDefault();
      void navigate({
        to: "/projects/$projectId/features/$featureId",
        params: {
          projectId: String(entry.project.id),
          featureId: String(entry.feature.id),
        },
      });
    },
    { enabled: isActive },
  );
  const baseClass = cn(
    "group/card relative flex h-full min-h-[420px] flex-col overflow-hidden rounded-[10px] border bg-card outline-none transition-[border-color,box-shadow] duration-200",
    // Active = focused agent (set via `onFocusCapture={activate}`). The
    // active class paints a primary-tinted border + floating shadow and
    // plays a one-shot 200ms border flash; the global
    // `data-animations="off"` kill-switch collapses it to a static state.
    // `--card` and `--background` resolve to the same color in dark mode, so
    // the card body, its inner embedded header (bg-background), and the
    // surrounding grid all share a bg. The border is the *only* delineator
    // — at /40 it disappears at the top edge — so keep the resting opacity
    // high enough to read while still being discreet.
    isActive ? "unified-agent-active" : "border-border/70 hover:border-primary/35",
  );

  return (
    <section
      tabIndex={0}
      data-unified-agent-index={index}
      onFocusCapture={activate}
      onPointerDownCapture={activate}
      onMouseEnter={prefetchFeature}
      onFocus={prefetchFeature}
      className={baseClass}
    >
      <ResolvedModelProvider featureId={entry.feature.id} projectId={entry.project.id}>
        <WebSocketSessionFeatureBlock
          sessionId={wsSessionIdFromFeature(entry.feature.id)}
          cwd={entry.project.path}
          featureId={entry.feature.id}
          projectId={entry.project.id}
          layoutFeatureId={-entry.session.sessionDbId}
          embedded
          hotkeysEnabled={isActive}
          onActivate={activate}
          projectName={entry.project.name}
          featureTitle={entry.feature.title}
          featureLabel={entry.feature.label}
          lastActivityAt={entry.last_activity_at}
          isPinned={entry.is_pinned}
          isPinPending={pinControls.isPending}
          onTogglePin={pinControls.toggle}
          onExclude={excludeAgent}
        />
      </ResolvedModelProvider>
    </section>
  );
});

function useHydrateUnifiedWsSession(entry: UnifiedAgentEntry): void {
  const sessionId = wsSessionIdFromFeature(entry.feature.id);
  useLayoutEffect(() => {
    const current = useWsSessionStore.getState().sessions[sessionId];
    ensureWsSessionEntry(sessionId);
    // Two cases:
    // 1. Fresh session (no persisted load, no live WS conn) — seed
    //    everything from REST: blocks via `setPersistedState`, and
    //    metadata/lifecycle via the patch.
    // 2. Live session — WS handler is the canonical owner of every
    //    SessionEntry field (pendingPermission, pendingQuestions,
    //    pendingPlanApproval, blocks, lifecycle, …). Re-applying REST
    //    here clobbers fresher WS state: it has been observed to
    //    convert a live plan-approval gate into a stale permission
    //    gate, and to drop the live pendingQuestions form when the
    //    user navigates from the feature view to the unified grid.
    //    So we only patch on bootstrap.
    if (shouldRestoreUnifiedBlocks(current)) {
      useWsSessionStore.getState().setPersistedState(sessionId, buildPersistedSnapshot(entry));
      patchHydratedSession(sessionId, entry);
    }
  }, [entry, sessionId]);
}

function shouldRestoreUnifiedBlocks(session: SessionEntry | undefined): boolean {
  if (!session) return true;
  if (session.persistedLoaded || session.blocks.length > 0) return false;
  return !session.conn && !session.isConnected && !session.serverSessionId;
}

function ensureWsSessionEntry(sessionId: string): void {
  if (useWsSessionStore.getState().sessions[sessionId]) return;
  useWsSessionStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: createSessionEntry(),
    },
  }));
}

function patchHydratedSession(sessionId: string, entry: UnifiedAgentEntry): void {
  useWsSessionStore.setState((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;
    const patch = buildUnifiedSessionPatch(entry, session);
    if (!hasSessionPatchChanges(session, patch)) return state;
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: { ...session, ...patch },
      },
    };
  });
}

function buildPersistedSnapshot(entry: UnifiedAgentEntry): PersistedSnapshot {
  const pendingPermission = asPendingPermission(entry.session.pendingPermission);
  const pendingQuestions = asQuestions(entry.session.pendingQuestions) ?? [];
  return {
    blocks: serverBlocksToAgentBlocks(entry.session.blocks),
    // Bootstrap seed only. The live agent-status badge reads from
    // `session-status-store`; this lifecycle exists for cross-feature
    // consumers that iterate `ws-session-store.sessions[*].lifecycle` —
    // `usePowerBusySignal` (powerSaveBlocker), `useAppClose` (CMD+W
    // confirmation), `__root.tsx` "Stop all agents", and `usePowerEvents`
    // (suspended-reason tracking). Without this seed, an agent that was
    // already running before app launch wouldn't be detected by those
    // consumers until the user opens its feature and WS turn events fire.
    // The WS handler overwrites this on the next turn event.
    lifecycle: persistedSessionToLifecycle(
      {
        ...entry.session,
        pendingPermission,
        pendingQuestions,
      },
      { runningStatus: "active" },
    ),
    hasMore: entry.session.hasMore,
    oldestMessageId: entry.session.oldestMessageId,
    featureId: entry.feature.id,
    sessionDbId: entry.session.sessionDbId,
    currentProviderId: entry.session.runtimeProvider ?? undefined,
    currentModelId: entry.session.model ?? undefined,
    currentProfile: entry.session.profile ?? undefined,
    runtimeProvider: entry.session.runtimeProvider,
    runtimeSessionId: entry.session.runtimeSessionId,
    codexPermissionMode: parseCodexPermissionMode(entry.session.codexPermissionMode),
    contextUsage: buildContextUsage(entry),
    hasFileChanges: entry.session.hasFileChanges,
  };
}

function buildUnifiedSessionPatch(
  entry: UnifiedAgentEntry,
  session: SessionEntry,
): Partial<SessionEntry> {
  const pendingPermission = asPendingPermission(entry.session.pendingPermission);
  const pendingQuestions = asQuestions(entry.session.pendingQuestions) ?? [];
  const permissionMode = parsePermissionMode(entry.session.permissionMode);
  const lifecycle = persistedSessionToLifecycle(
    {
      ...entry.session,
      pendingPermission,
      pendingQuestions,
    },
    { runningStatus: "active" },
  );
  const patch: Partial<SessionEntry> = {
    pendingPermission,
    pendingQuestions,
    contextUsage: buildContextUsage(entry),
    hasFileChanges: entry.session.hasFileChanges,
    hasMore: entry.session.hasMore,
    oldestMessageId: entry.session.oldestMessageId,
    featureId: entry.feature.id,
    sessionDbId: entry.session.sessionDbId,
    ...(permissionMode ? { permissionMode } : {}),
    codexPermissionMode: parseCodexPermissionMode(entry.session.codexPermissionMode),
    ...(entry.session.runtimeProvider ? { currentProviderId: entry.session.runtimeProvider } : {}),
    ...(entry.session.model ? { currentModelId: entry.session.model } : {}),
    ...(entry.session.profile ? { currentProfile: entry.session.profile } : {}),
    ...(entry.session.runtimeProvider ? { runtimeProvider: entry.session.runtimeProvider } : {}),
    ...(entry.session.runtimeSessionId ? { runtimeSessionId: entry.session.runtimeSessionId } : {}),
    ...pendingRequestIdPatch(pendingPermission, pendingQuestions),
  };
  // Guarded patch: never demote a session whose WS handler has already
  // moved it to "active" with a stale REST snapshot, but freely apply
  // upgrades (active/paused) and any change while the session is idle.
  if (shouldPatchLifecycle(session, lifecycle)) {
    patch.lifecycle = lifecycle;
  }
  return patch;
}

function pendingRequestIdPatch(
  pendingPermission: PendingPermission | null,
  pendingQuestions: AgentQuestion[],
): Partial<SessionEntry> {
  if (pendingPermission?.requestId) return { pendingRequestId: pendingPermission.requestId };
  if (!pendingPermission && pendingQuestions.length === 0) return { pendingRequestId: "" };
  return {};
}

function shouldPatchLifecycle(session: SessionEntry, nextLifecycle: TurnLifecycle): boolean {
  if (nextLifecycle.phase === "active" || nextLifecycle.phase === "paused") return true;
  return session.lifecycle.phase !== "active";
}

function hasSessionPatchChanges(session: SessionEntry, patch: Partial<SessionEntry>): boolean {
  for (const key of Object.keys(patch)) {
    const typedKey = key as keyof SessionEntry;
    if (!sessionFieldEquals(session[typedKey], patch[typedKey])) return true;
  }
  return false;
}

function sessionFieldEquals(current: unknown, next: unknown): boolean {
  if (Object.is(current, next)) return true;
  return safeStringify(current) === safeStringify(next);
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPendingPermission(value: unknown): PendingPermission | null {
  return isObject(value) ? (value as unknown as PendingPermission) : null;
}

function asQuestions(value: unknown): AgentQuestion[] | undefined {
  return Array.isArray(value) ? (value as AgentQuestion[]) : undefined;
}

function buildContextUsage(entry: UnifiedAgentEntry): ContextUsageState {
  return {
    inputTokens: entry.session.inputTokens,
    outputTokens: entry.session.outputTokens,
    contextWindow: normalizeContextWindow(entry.session.contextWindow),
    wasCompacted: entry.session.wasCompacted,
  };
}
