import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { AgentSessionHandle } from "@/components/agent-session";
import type { FeatureTerminalTabHandle } from "@/components/FeatureTerminalTab";
import {
  useGetBranch,
  useGetFeatureSettings,
  useGetGitStatus,
  useListProjects,
} from "@/api/generated";
import { useGitStatusSubscription } from "@/hooks/useGitStatusSubscription";
import { useAgentLetterFocus } from "@/hooks/useAgentLetterFocus";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { nextThinkingEffort } from "@/shared/thinking-effort";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import type { FeatureEditorTabHandle } from "@/components/editor/FeatureEditorTab";
import type { WorktreeStatus } from "@/types/workflow";
import type { SessionControls } from "@/components/WebSocketSessionControls";
import { PROVIDER_IDS } from "@/lib/providers";
import { useFeatureWorktreePath } from "@/hooks/useFeatureWorktreePath";
export { useSessionControls } from "@/components/WebSocketSessionControls";

/** The Claude profile to attach to an outgoing prompt, or undefined for non-Claude providers. */
export function claudeProfileForPrompt(controls: SessionControls): string | undefined {
  return controls.activeProviderId === PROVIDER_IDS.CLAUDE_CODE
    ? controls.claudeProfile.selectedClaudeProfile
    : undefined;
}

interface SessionRefs {
  agent: RefObject<AgentSessionHandle | null>;
  terminal: RefObject<FeatureTerminalTabHandle | null>;
  editor: RefObject<FeatureEditorTabHandle | null>;
}
interface SessionFeatureData {
  projectPath: string;
  gitBranch: string | undefined;
  defaultBranch: string | undefined;
  featureSettings: Record<string, string>;
  session: ReturnType<typeof useWsSessionStore.getState>["sessions"][string] | undefined;
  effectiveCwd: string;
  worktreeStatus: WorktreeStatus;
  worktreeBranch: string | null;
  requestSlashCommands: ReturnType<typeof useWsSessionStore.getState>["requestSlashCommands"];
  handleRetryWorktreeSetup: () => void;
}

export function useSessionRefs(): SessionRefs {
  const agent = useRef<AgentSessionHandle>(null);
  const terminal = useRef<FeatureTerminalTabHandle>(null);
  const editor = useRef<FeatureEditorTabHandle>(null);
  return useMemo(() => ({ agent, terminal, editor }), []);
}

export function useSessionFeatureData(
  sessionId: string,
  cwd: string,
  featureId: number,
  projectId: number,
  options?: { gitMetadataEnabled?: boolean; projectLookupEnabled?: boolean },
): SessionFeatureData {
  const gitMetadataEnabled = options?.gitMetadataEnabled ?? true;
  const projectLookupEnabled = options?.projectLookupEnabled ?? true;
  const projectsQuery = useListProjects({
    query: { enabled: projectLookupEnabled },
  });
  const projectPath = projectsQuery.data?.find((p) => p.id === projectId)?.path;
  const worktreePath = useFeatureWorktreePath(featureId, projectId);
  useGitStatusSubscription(gitMetadataEnabled ? featureId : null);
  const { data: initialGitStatus } = useGetGitStatus(
    { feature_id: featureId },
    { query: { enabled: gitMetadataEnabled } },
  );
  const { data: branchData } = useGetBranch(
    { project_id: projectId },
    { query: { enabled: gitMetadataEnabled } },
  );
  const { data: featureSettingsData } = useGetFeatureSettings(featureId);
  const featureSettings = useMemo(
    () =>
      Object.fromEntries(
        (featureSettingsData ?? []).map((setting) => [setting.key, setting.value]),
      ),
    [featureSettingsData],
  );
  const session = useWsSessionStore((state) => state.sessions[sessionId]);
  const liveWorktreeBranch = useWsSessionStore(
    (state) => state.sessions[sessionId]?.worktreeBranch,
  );
  const requestSlashCommands = useWsSessionStore((state) => state.requestSlashCommands);
  const retryWorktreeSetup = useWsSessionStore((state) => state.retryWorktreeSetup);
  const gitBranch =
    liveWorktreeBranch ?? featureSettings.worktree_branch ?? branchData?.branch ?? undefined;
  const defaultBranch = branchData?.branch ?? undefined;
  const effectiveCwd =
    worktreePath === undefined
      ? (session?.worktreePath ?? featureSettings.worktree_path ?? cwd)
      : (worktreePath ?? projectPath ?? cwd);
  const worktreeStatus =
    session?.worktreeStatus && session.worktreeStatus !== "idle"
      ? session.worktreeStatus
      : statusFromFeatureSettings(featureSettings);
  const worktreeBranch = liveWorktreeBranch ?? featureSettings.worktree_branch ?? null;
  const handleRetryWorktreeSetup = useCallback(
    (): void => retryWorktreeSetup(sessionId),
    [retryWorktreeSetup, sessionId],
  );
  useEffect(() => {
    if (initialGitStatus) {
      useGitStatusStore.getState().setStatus(initialGitStatus);
    }
  }, [initialGitStatus]);
  return useMemo<SessionFeatureData>(
    () => ({
      projectPath: projectPath ?? cwd,
      gitBranch,
      defaultBranch,
      featureSettings,
      session,
      effectiveCwd,
      worktreeStatus,
      worktreeBranch,
      requestSlashCommands,
      handleRetryWorktreeSetup,
    }),
    [
      cwd,
      defaultBranch,
      effectiveCwd,
      featureSettings,
      gitBranch,
      handleRetryWorktreeSetup,
      projectPath,
      requestSlashCommands,
      session,
      worktreeBranch,
      worktreeStatus,
    ],
  );
}

function statusFromFeatureSettings(settings: Record<string, string>): WorktreeStatus {
  const raw = settings.worktree_setup_step;
  if (raw === "ready") return "ready";
  if (raw === "setup_running" || raw === "setup") return "setup_running";
  if (raw === "setup_error" || raw === "error") return "setup_error";
  if (raw === "created") return "created";
  if (raw === "creating" || raw === "naming" || raw === "named") {
    return "creating";
  }
  return settings.worktree_path || settings.worktree_branch ? "ready" : "idle";
}

interface WsSessionEffectsArgs {
  sessionId: string;
  cwd: string;
  featureId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: SessionControls;
  refs: ReturnType<typeof useSessionRefs>;
  focusedTabId: string;
  hotkeysEnabled: boolean;
  autoFocusPrompt: boolean;
  autoInitSession: boolean;
}

function useSessionInitialization({
  sessionId,
  cwd,
  featureId,
  data,
  controls,
  autoInitSession,
}: WsSessionEffectsArgs): void {
  const { initSession, isConnected } = controls.ws;
  const serverSessionId = data.session?.serverSessionId;
  const persistedLoaded = data.session?.persistedLoaded ?? false;
  useEffect(() => {
    if (!autoInitSession) return;
    if (!isConnected || controls.initializedRef.current === sessionId) return;
    if (serverSessionId !== "" || !persistedLoaded) return;
    controls.initializedRef.current = sessionId;
    // No provider/model/effort: this effect only runs for a brand-new session,
    // and the frontend resolvers return catalog fallbacks until the selection
    // query settles. The backend treats any pair we send as pinned, so it must
    // resolve this one itself — it reads the same settings, with the live
    // catalog we do not have here.
    initSession({
      cwd,
      featureId,
      permissionMode: controls.ws.permissionMode,
    });
  }, [
    autoInitSession,
    controls.initializedRef,
    controls.ws.permissionMode,
    cwd,
    featureId,
    initSession,
    isConnected,
    persistedLoaded,
    serverSessionId,
    sessionId,
  ]);
}

export function useWsSessionEffects(args: WsSessionEffectsArgs): void {
  const { sessionId, data, controls, refs, focusedTabId, hotkeysEnabled, autoFocusPrompt } = args;
  const serverSessionId = data.session?.serverSessionId;
  useAgentLetterFocus({
    enabled: hotkeysEnabled && focusedTabId === "agent",
    onFocus: () => refs.agent.current?.focusActiveInput(),
  });
  useSessionInitialization(args);
  useEffect(() => {
    if (!autoFocusPrompt) return undefined;
    if (!hotkeysEnabled || focusedTabId !== "agent") return undefined;
    const frame = requestAnimationFrame(() => refs.agent.current?.focusPromptBar());
    return () => cancelAnimationFrame(frame);
  }, [autoFocusPrompt, focusedTabId, hotkeysEnabled, refs.agent, sessionId]);
  useEffect(() => {
    const handler = (): void => {
      // `autoFocusPrompt` is false on phones, so notification-driven focus
      // won't pop the keyboard there either.
      if (autoFocusPrompt && hotkeysEnabled) refs.agent.current?.focusPromptBar();
    };
    window.addEventListener("cadencr:focus-prompt", handler);
    return () => window.removeEventListener("cadencr:focus-prompt", handler);
  }, [autoFocusPrompt, hotkeysEnabled, refs.agent]);
  useEffect(() => {
    if (!hotkeysEnabled) return;
    if (serverSessionId && data.effectiveCwd) {
      data.requestSlashCommands(sessionId, data.effectiveCwd, controls.activeProviderId);
    }
  }, [
    controls.activeProviderId,
    data.effectiveCwd,
    data.requestSlashCommands,
    hotkeysEnabled,
    serverSessionId,
    sessionId,
  ]);
}

export function useWsSessionShortcuts(args: {
  controls: SessionControls;
  hotkeysEnabled: boolean;
}): void {
  const { controls, hotkeysEnabled } = args;
  useScopedShortcut(
    "agent-thinking",
    (e) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.closest("[data-agent-prompt-bar='true']")) {
        return;
      }
      if (controls.supportedThinkingEfforts.length === 0) return;
      e.preventDefault();
      const next = nextThinkingEffort(
        controls.supportedThinkingEfforts,
        controls.ws.currentThinkingEffort,
      );
      if (next) controls.ws.setThinkingEffort(next);
    },
    "agent",
    { enabled: hotkeysEnabled },
  );
}
