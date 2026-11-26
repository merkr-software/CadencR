import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { AgentSessionHandle } from "@/components/agent-session";
import type { FeatureTerminalTabHandle } from "@/components/FeatureTerminalTab";
import { useGetBranch, useGetFeatureSettings, useListProjects } from "@/api/generated";
import { useInitialGitStatus } from "@/hooks/useInitialGitStatus";
import { useGitStatusSubscription } from "@/hooks/useGitStatusSubscription";
import { useAgentLetterFocus } from "@/hooks/useAgentLetterFocus";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { focusInSkillWizard } from "@/components/composer/skill-wizard-focus";
import { nextThinkingEffort } from "@/shared/thinking-effort";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { FeatureEditorTabHandle } from "@/components/editor/FeatureEditorTab";
import type { WorktreeStatus } from "@/types/workflow";
import type { SessionControls } from "@/components/WebSocketSessionControls";
import { applyThinkingEffort } from "@/components/sessionThinkingEffort";
import { PROVIDER_IDS } from "@/lib/providers";
import { useFeatureWorktreePath } from "@/hooks/useFeatureWorktreePath";
import { useWorkspaceSession } from "@/hooks/useWorkspaceSession";
import { useWorkspaceActivity } from "@/components/workspace-pool/workspace-activity";
export { useSessionControls } from "@/components/WebSocketSessionControls";

/** The selected native profile to attach to an outgoing prompt when supported. */
export function claudeProfileForPrompt(controls: SessionControls): string | undefined {
  return controls.supportsProfiles || controls.activeProviderId === PROVIDER_IDS.CLAUDE_CODE
    ? controls.claudeProfile.promptProfile
    : undefined;
}

interface SessionRefs {
  agent: RefObject<AgentSessionHandle | null>;
  terminal: RefObject<FeatureTerminalTabHandle | null>;
  editor: RefObject<FeatureEditorTabHandle | null>;
}
interface SessionFeatureData {
  projectPath: string;
  projectName: string | undefined;
  /** Git-verified feature worktree; `null` in the project root, `undefined` while unresolved. */
  worktreePath: string | null | undefined;
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
  const project = projectsQuery.data?.find((p) => p.id === projectId);
  const projectPath = project?.path;
  const projectName = project?.name;
  const worktreePath = useFeatureWorktreePath(featureId, projectId);
  useGitStatusSubscription(gitMetadataEnabled ? featureId : null);
  useInitialGitStatus(featureId, gitMetadataEnabled);
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
  const session = useWorkspaceSession(sessionId);
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
      : (worktreePath ?? featureSettings.worktree_path ?? projectPath ?? cwd);
  const worktreeStatus =
    session?.worktreeStatus && session.worktreeStatus !== "idle"
      ? session.worktreeStatus
      : statusFromFeatureSettings(featureSettings);
  const worktreeBranch = liveWorktreeBranch ?? featureSettings.worktree_branch ?? null;
  const handleRetryWorktreeSetup = useCallback(
    (): void => retryWorktreeSetup(sessionId),
    [retryWorktreeSetup, sessionId],
  );
  return useMemo<SessionFeatureData>(
    () => ({
      projectPath: projectPath ?? cwd,
      projectName,
      worktreePath,
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
      projectName,
      projectPath,
      requestSlashCommands,
      session,
      worktreeBranch,
      worktreePath,
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
  const pendingPermissionMode = data.session?.pendingInitPermissionMode;
  const persistedLoaded = data.session?.persistedLoaded ?? false;
  // Embedded cards skip init on mount, but a prompt sent from one is only
  // queued until `session.initialized` — so init on demand (issue #251). The
  // in-flight guard also lets a refused or socket-dropped init be retried by
  // the next queued prompt instead of looping on mount.
  const needsOnDemandInit =
    (data.session?.queuedPrompts.length ?? 0) > 0 && data.session?.initRequestId === null;
  useEffect(() => {
    if (!isConnected || serverSessionId !== "" || !persistedLoaded) return;
    const initOnMount = autoInitSession && controls.initializedRef.current !== sessionId;
    if (!initOnMount && !needsOnDemandInit) return;
    // A card and the full view can share this session; read the live entry so
    // two effects in one commit don't both send an init.
    const latest = useWsSessionStore.getState().sessions[sessionId];
    if (latest?.initRequestId) return;
    controls.initializedRef.current = sessionId;
    // No provider/model/effort: the frontend resolvers return catalog
    // fallbacks until the selection query settles. The backend treats any
    // pair we send as pinned, so it must resolve this one itself — it reads
    // the persisted session row and settings, with the live catalog we do
    // not have here.
    initSession({
      cwd,
      featureId,
      permissionMode:
        (latest ? latest.pendingInitPermissionMode : pendingPermissionMode) ?? undefined,
    });
  }, [
    autoInitSession,
    controls.initializedRef,
    cwd,
    featureId,
    initSession,
    isConnected,
    needsOnDemandInit,
    pendingPermissionMode,
    persistedLoaded,
    serverSessionId,
    sessionId,
  ]);
}

/**
 * Showing a workspace again (`WorkspacePool`) gives focus back to the tab it
 * shows, the way a requested tab is focused (`useRequestedTabFocus`): the
 * prompt, the terminal or the editor. Only on a hidden → shown transition: on
 * mount the tabs focus themselves.
 */
function useFocusWhenShown({
  refs,
  focusedTabId,
  hotkeysEnabled,
  autoFocusPrompt,
}: WsSessionEffectsArgs): void {
  const activity = useWorkspaceActivity();
  const latest = useRef({ focusedTabId, autoFocusPrompt });
  useLayoutEffect(() => {
    latest.current = { focusedTabId, autoFocusPrompt };
  }, [autoFocusPrompt, focusedTabId]);
  useEffect(() => {
    if (!hotkeysEnabled) return undefined;
    let frame = 0;
    const unsubscribe = activity.subscribe(() => {
      cancelAnimationFrame(frame);
      if (!activity.isActive()) return;
      // A frame later, when the tab this switch asked for (`WorkspacePool`) is
      // the focused one.
      frame = requestAnimationFrame(() => {
        const { focusedTabId: tab, autoFocusPrompt: promptAllowed } = latest.current;
        if (tab === "agent" && promptAllowed) refs.agent.current?.focusPromptBar();
        else if (tab === "terminal") refs.terminal.current?.activate();
        else if (tab === "editor") refs.editor.current?.focusActiveEditor();
      });
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [activity, hotkeysEnabled, refs.agent, refs.editor, refs.terminal]);
}

export function useWsSessionEffects(args: WsSessionEffectsArgs): void {
  const { sessionId, data, controls, refs, focusedTabId, hotkeysEnabled, autoFocusPrompt } = args;
  const serverSessionId = data.session?.serverSessionId;
  useAgentLetterFocus({
    enabled: hotkeysEnabled && focusedTabId === "agent",
    onFocus: () => refs.agent.current?.focusActiveInput(),
  });
  useSessionInitialization(args);
  // A workspace kept mounted but hidden (see `WorkspacePool`) leaves focus
  // alone; `useFocusWhenShown` takes it back each time it is shown again.
  const activity = useWorkspaceActivity();
  useEffect(() => {
    if (!autoFocusPrompt || !hotkeysEnabled || focusedTabId !== "agent") return undefined;
    if (!activity.isActive()) return undefined;
    const frame = requestAnimationFrame(() => refs.agent.current?.focusPromptBar());
    return () => cancelAnimationFrame(frame);
  }, [activity, autoFocusPrompt, focusedTabId, hotkeysEnabled, refs.agent, sessionId]);
  useFocusWhenShown(args);
  useEffect(() => {
    const handler = (): void => {
      // `autoFocusPrompt` is false on phones, so notification-driven focus
      // won't pop the keyboard there either.
      if (autoFocusPrompt && hotkeysEnabled && activity.isActive()) {
        refs.agent.current?.focusPromptBar();
      }
    };
    window.addEventListener("cadencr:focus-prompt", handler);
    return () => window.removeEventListener("cadencr:focus-prompt", handler);
  }, [activity, autoFocusPrompt, hotkeysEnabled, refs.agent]);
  useEffect(() => {
    if (!hotkeysEnabled) return;
    if (serverSessionId && data.effectiveCwd) {
      data.requestSlashCommands(
        sessionId,
        data.effectiveCwd,
        controls.activeProviderId,
        controls.supportsProfiles ? controls.claudeProfile.promptProfile : undefined,
      );
    }
  }, [
    controls.activeProviderId,
    controls.claudeProfile.promptProfile,
    controls.supportsProfiles,
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
      const promptBar =
        active instanceof HTMLElement ? active.closest("[data-agent-prompt-bar='true']") : null;
      if (!promptBar || focusInSkillWizard(promptBar)) return;
      if (controls.supportedThinkingEfforts.length === 0) return;
      e.preventDefault();
      const next = nextThinkingEffort(
        controls.supportedThinkingEfforts,
        controls.ws.currentThinkingEffort,
      );
      // Same path as the composer's effort control (Codex: runtime override).
      if (next) applyThinkingEffort(controls, next);
    },
    "agent",
    { enabled: hotkeysEnabled },
  );
}
