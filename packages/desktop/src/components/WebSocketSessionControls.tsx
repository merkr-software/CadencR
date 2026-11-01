import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  useAgentCatalog,
  type RuntimeProviderAccessModeOption,
  type RuntimeProviderModeOption,
} from "@/api/agentRuntime";
import { useGetProjectSettings, useSetProjectSetting } from "@/api/generated";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { useResolvedModelContext } from "@/contexts/ResolvedModelContext";
import { useWebSocketSession } from "@/hooks/useWebSocketSession";
import { useEnabledOptInModes } from "@/hooks/useEnabledOptInModes";
import {
  DEFAULT_WORKTREE_MODE_KEY,
  defaultWorktreeModeFromSettings,
} from "@/lib/default-worktree-mode";
import {
  defaultWorktreeMode,
  worktreeModeToProjectDefault,
  type WorktreeMode,
} from "@/lib/worktree-mode";
import { supportedThinkingEffortLevels } from "@/shared/thinking-effort";
import type { PermissionMode } from "@/types/permission-mode";
import type { AccessMode } from "@/types/access-mode";
import { useAccessModeSetting } from "@/hooks/useAccessModeSetting";
import {
  EMPTY_PROVIDER_MODES,
  usePermissionModeSet,
  usePermissionModeToggle,
} from "@/components/WebSocketSessionPermissionMode";
import type { ClaudeProfileSelection } from "@/components/agent-session/useClaudeProfileSelection";
import { useAgentProfileSelection } from "@/components/agent-session/useAgentProfileSelection";

type WsSession = ReturnType<typeof useWebSocketSession>;
const EMPTY_PROVIDER_ACCESS_MODES: readonly RuntimeProviderAccessModeOption[] = [];

interface WorktreePreferenceControls {
  worktreeMode: WorktreeMode;
  setWorktreeMode: (mode: WorktreeMode) => void;
}

interface RuntimeSelectionControls {
  agentCatalog: ReturnType<typeof useAgentCatalog>;
  resolvedProviderId: string;
  resolvedModelId: string;
  activeProviderId: string;
  supportedThinkingEfforts: ReturnType<typeof supportedThinkingEffortLevels>;
  enabledOptInModes: PermissionMode[];
  providerModes: readonly RuntimeProviderModeOption[];
  providerAccessModes: readonly RuntimeProviderAccessModeOption[];
  /** Whether the session's model can hold an `auto`-risk mode (unknown: undefined). */
  modelSupportsAutoMode: boolean | undefined;
  /** Mid-turn prompts reach the running turn and are acknowledged. */
  steeringAcknowledged: boolean;
  /** `/compact` is a session action Cadencr performs (catalog `compact_action`). */
  compactAction: boolean;
}

interface AccessControls {
  ws: WsSession;
  accessMode: AccessMode;
  accessModeDefault: AccessMode;
  isAccessModePending: boolean;
  handleAccessModeChange: (mode: AccessMode) => void;
}

export interface SessionControls
  extends WorktreePreferenceControls, RuntimeSelectionControls, AccessControls {
  selectedBranch: string | null;
  setSelectedBranch: Dispatch<SetStateAction<string | null>>;
  initializedRef: RefObject<string | null>;
  handlePermissionModeToggle: () => void;
  handlePermissionModeSet: (mode: PermissionMode) => void;
  claudeProfile: ClaudeProfileSelection;
  supportsProfiles: boolean;
  supportsConfigInheritance: boolean;
  initialCwd: string;
}

function useWorktreePreference(projectId: number): WorktreePreferenceControls {
  // Isolation is the default: until the project's saved preference loads (or
  // when it has none), a new conversation works in its own worktree.
  const [worktreeMode, setWorktreeModeState] = useState<WorktreeMode>("from_branch_worktree");
  const seededProjectRef = useRef<number | null>(null);
  const { data: projectSettingsData } = useGetProjectSettings(projectId);
  const setProjectSetting = useSetProjectSetting();
  const projectDefault = defaultWorktreeModeFromSettings(projectSettingsData, "new");
  // Seed the picker from the project's saved default once settings load — once
  // per project so a later settle doesn't clobber an explicit choice.
  useEffect(() => {
    if (projectSettingsData == null || seededProjectRef.current === projectId) {
      return;
    }
    seededProjectRef.current = projectId;
    setWorktreeModeState(defaultWorktreeMode(projectDefault));
  }, [projectDefault, projectId, projectSettingsData]);
  const setWorktreeMode = useCallback(
    (next: WorktreeMode): void => {
      setWorktreeModeState(next);
      // Persist the project default only for the two modes that map cleanly to
      // it; branch-specific modes (reuse / from_branch) leave it untouched. A
      // failed save still keeps the local pick for this session.
      const nextDefault = worktreeModeToProjectDefault(next);
      if (nextDefault == null || nextDefault === projectDefault) return;
      setProjectSetting.mutate(
        { id: projectId, data: { key: DEFAULT_WORKTREE_MODE_KEY, value: nextDefault } },
        {
          onError: (err) => toast.error(apiErrorMessage(err, "Failed to save worktree preference")),
        },
      );
    },
    [projectDefault, projectId, setProjectSetting],
  );
  return useMemo(() => ({ worktreeMode, setWorktreeMode }), [setWorktreeMode, worktreeMode]);
}

function useRuntimeSelection(
  ws: WsSession,
  effectiveCwd: string,
  agentCatalogEnabled: boolean,
  catalogClaudeProfile: string | undefined,
  resolvedProviderId: string,
): RuntimeSelectionControls {
  const { resolveModel } = useResolvedModelContext();
  const activeProviderId = ws.currentSelection?.providerId ?? resolvedProviderId;
  const agentCatalog = useAgentCatalog({
    cwd: effectiveCwd,
    provider: catalogClaudeProfile ? activeProviderId : undefined,
    profile: catalogClaudeProfile,
    enabled: agentCatalogEnabled,
    staleTime: 30_000,
  });
  const resolvedModelId = resolveModel("session");
  // `currentSelection` is the backend-confirmed pair; before it arrives, fall
  // back to the client-resolved provider so pre-connection UI (Claude profile
  // selector, catalog probe) isn't blocked on a round trip.
  const activeProvider = agentCatalog.data?.providers.find(
    (provider) => provider.id === activeProviderId,
  );
  const activeSessionModel = ws.currentSelection
    ? agentCatalog.data?.providers
        .find((provider) => provider.id === ws.currentSelection?.providerId)
        ?.models.find((model) => model.id === ws.currentSelection?.modelId)
    : undefined;
  const supportedThinkingEfforts = supportedThinkingEffortLevels(activeSessionModel);
  const enabledOptInModes = useEnabledOptInModes(activeProviderId);
  const providerModes = activeProvider?.modes ?? EMPTY_PROVIDER_MODES;
  const providerAccessModes = activeProvider?.access_modes ?? EMPTY_PROVIDER_ACCESS_MODES;
  const modelSupportsAutoMode = activeSessionModel?.supports_auto_mode ?? undefined;
  // Unknown (catalog still loading) keeps today's behavior: Enter steers.
  const steeringAcknowledged = !ws.isCompacting && (activeProvider?.steering_acknowledged ?? true);
  const compactAction = activeProvider?.compact_action ?? false;
  return useMemo(
    () => ({
      modelSupportsAutoMode,
      steeringAcknowledged,
      compactAction,
      agentCatalog,
      resolvedProviderId,
      resolvedModelId,
      activeProviderId,
      supportedThinkingEfforts,
      enabledOptInModes,
      providerModes,
      providerAccessModes,
    }),
    [
      activeProviderId,
      agentCatalog,
      compactAction,
      enabledOptInModes,
      modelSupportsAutoMode,
      steeringAcknowledged,
      providerModes,
      providerAccessModes,
      resolvedModelId,
      resolvedProviderId,
      supportedThinkingEfforts,
    ],
  );
}

function useAccessControls(ws: WsSession, providerId: string): AccessControls {
  const {
    globalAccessMode,
    isPending,
    isLoading,
    isError,
    providerLabel,
    handleAccessModeChange: handleGlobalAccessModeChange,
  } = useAccessModeSetting(providerId);
  const hasStartedConversation = ws.blocks.length > 0 || ws.runtimeSessionId !== "";
  const followsDefault = !!providerLabel && !hasStartedConversation;
  const defaultReady = followsDefault && !isError && !isLoading && !isPending;
  const { accessMode: sessionAccessMode, setAccessMode } = ws;
  const accessMode = defaultReady ? globalAccessMode : sessionAccessMode;
  const isAccessModePending = isPending || (followsDefault && isLoading);
  const promptWs = useFirstPromptAccessMode(ws, defaultReady ? accessMode : null);
  const handleAccessModeChange = useCallback(
    (mode: AccessMode): void => {
      if (mode !== sessionAccessMode) setAccessMode(mode);
      if (mode !== globalAccessMode) handleGlobalAccessModeChange(mode);
    },
    [globalAccessMode, handleGlobalAccessModeChange, sessionAccessMode, setAccessMode],
  );
  return useMemo(
    () => ({
      ws: promptWs,
      accessMode,
      accessModeDefault: globalAccessMode,
      isAccessModePending,
      handleAccessModeChange,
    }),
    [accessMode, globalAccessMode, handleAccessModeChange, isAccessModePending, promptWs],
  );
}

function useFirstPromptAccessMode(ws: WsSession, accessMode: AccessMode | null): WsSession {
  const { sendPrompt: dispatchPrompt, setAccessMode } = ws;
  const sendPrompt = useCallback<WsSession["sendPrompt"]>(
    (...args) => {
      // Empty sessions may have initialized before the workspace default changed.
      // Record the displayed choice even when it matches the pre-init seed.
      if (accessMode !== null) setAccessMode(accessMode);
      dispatchPrompt(...args);
    },
    [accessMode, dispatchPrompt, setAccessMode],
  );
  return useMemo(
    () => (accessMode === null ? ws : { ...ws, sendPrompt }),
    [accessMode, sendPrompt, ws],
  );
}

export function useSessionControls(
  sessionId: string,
  featureId: number,
  projectId: number,
  effectiveCwd: string,
  options?: { agentCatalogEnabled?: boolean; loadPersistedState?: boolean },
): SessionControls {
  const ws = useWebSocketSession(sessionId, featureId, {
    loadPersisted: options?.loadPersistedState ?? true,
  });
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const initializedRef = useRef<string | null>(null);
  const worktree = useWorktreePreference(projectId);
  // Resolve the active provider and the Claude profile before the catalog query
  // so a profile chosen in the prompt-area selector scopes the model probe
  // (issue #76: the prompt selector must refresh the model list, like settings).
  // resolvedProviderId is computed once here and threaded into the runtime hook.
  const { resolveProvider } = useResolvedModelContext();
  const resolvedProviderId = resolveProvider("session");
  const activeProviderId = ws.currentSelection?.providerId ?? resolvedProviderId;
  const baseCatalog = useAgentCatalog({ cwd: effectiveCwd, enabled: options?.agentCatalogEnabled });
  const supportsProfiles = Boolean(
    baseCatalog.data?.providers.find((provider) => provider.id === activeProviderId)
      ?.profile_capability,
  );
  const supportsConfigInheritance = Boolean(
    baseCatalog.data?.providers.find((provider) => provider.id === activeProviderId)
      ?.profile_capability?.supports_config_inheritance,
  );
  const claudeProfile = useAgentProfileSelection({
    providerId: activeProviderId,
    supportsProfiles,
    cwd: effectiveCwd,
    wsSessionId: sessionId,
    sessionProfile: ws.currentProfile,
    onSessionProfileChange: ws.setProfile,
  });
  const runtime = useRuntimeSelection(
    ws,
    effectiveCwd,
    options?.agentCatalogEnabled ?? true,
    supportsProfiles ? claudeProfile.catalogProfile : undefined,
    resolvedProviderId,
  );
  useEffect(() => {
    if (
      ws.runtimeSessionId &&
      ws.sessionConfigSupported === null &&
      !ws.sessionConfigLoading &&
      !ws.sessionConfigError
    ) {
      void ws.requestSessionConfig();
    }
  }, [
    ws.requestSessionConfig,
    ws.runtimeSessionId,
    ws.sessionConfigError,
    ws.sessionConfigLoading,
    ws.sessionConfigSupported,
  ]);
  const access = useAccessControls(ws, runtime.activeProviderId);
  const handlePermissionModeToggle = usePermissionModeToggle(
    sessionId,
    runtime.activeProviderId,
    runtime.enabledOptInModes,
    runtime.providerModes,
  );
  const handlePermissionModeSet = usePermissionModeSet(sessionId);
  return useMemo<SessionControls>(
    () => ({
      ...worktree,
      selectedBranch,
      setSelectedBranch,
      initializedRef,
      ...runtime,
      handlePermissionModeToggle,
      handlePermissionModeSet,
      claudeProfile,
      supportsProfiles,
      supportsConfigInheritance,
      ...access,
      initialCwd: effectiveCwd,
    }),
    [
      claudeProfile,
      access,
      effectiveCwd,
      handlePermissionModeSet,
      handlePermissionModeToggle,
      initializedRef,
      runtime,
      selectedBranch,
      supportsProfiles,
      supportsConfigInheritance,
      worktree,
    ],
  );
}
