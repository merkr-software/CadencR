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
import type { useResolvedModel } from "@/hooks/useResolvedModel";
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
  usePermissionModeToggle,
} from "@/components/WebSocketSessionPermissionMode";
import { PROVIDER_IDS } from "@/lib/providers";
import {
  useClaudeProfileSelection,
  type ClaudeProfileSelection,
} from "@/components/agent-session/useClaudeProfileSelection";

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
  resolvedThinkingEffort: string | undefined;
  activeProviderId: string;
  supportedThinkingEfforts: ReturnType<typeof supportedThinkingEffortLevels>;
  enabledOptInModes: PermissionMode[];
  providerModes: readonly RuntimeProviderModeOption[];
  providerAccessModes: readonly RuntimeProviderAccessModeOption[];
  resolveModelThinkingEffort: ReturnType<typeof useResolvedModel>["resolveModelThinkingEffort"];
}

interface AccessControls {
  accessMode: AccessMode;
  accessModeDefault: AccessMode;
  isAccessModePending: boolean;
  handleAccessModeChange: (mode: AccessMode) => void;
}

export interface SessionControls
  extends WorktreePreferenceControls, RuntimeSelectionControls, AccessControls {
  ws: WsSession;
  selectedBranch: string | null;
  setSelectedBranch: Dispatch<SetStateAction<string | null>>;
  initializedRef: RefObject<string | null>;
  handlePermissionModeToggle: () => void;
  claudeProfile: ClaudeProfileSelection;
  initialCwd: string;
}

function useWorktreePreference(projectId: number): WorktreePreferenceControls {
  const [worktreeMode, setWorktreeModeState] = useState<WorktreeMode>("on_branch");
  const seededProjectRef = useRef<number | null>(null);
  const { data: projectSettingsData } = useGetProjectSettings(projectId);
  const setProjectSetting = useSetProjectSetting();
  const projectDefault = defaultWorktreeModeFromSettings(projectSettingsData, "skip");
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

// The active provider is known from the ws handle / resolved session provider
// before the catalog loads, so callers can resolve it up front to drive Claude
// profile selection and then feed the chosen profile back into the catalog.
function activeProviderIdOf(ws: WsSession, resolvedProviderId: string): string {
  return ws.currentProviderId || ws.runtimeProvider || resolvedProviderId;
}

function useRuntimeSelection(
  ws: WsSession,
  effectiveCwd: string,
  agentCatalogEnabled: boolean,
  catalogClaudeProfile: string | undefined,
  resolvedProviderId: string,
): RuntimeSelectionControls {
  const { resolveModel, resolveModelThinkingEffort } = useResolvedModelContext();
  const agentCatalog = useAgentCatalog({
    cwd: effectiveCwd,
    profile: catalogClaudeProfile,
    enabled: agentCatalogEnabled,
    staleTime: 30_000,
  });
  const resolvedModelId = resolveModel("session");
  const resolvedThinkingEffort = resolveModelThinkingEffort(resolvedProviderId, resolvedModelId);
  const activeProviderId = activeProviderIdOf(ws, resolvedProviderId);
  const activeProvider = agentCatalog.data?.providers.find(
    (provider) => provider.id === activeProviderId,
  );
  const activeSessionModel = agentCatalog.data?.providers
    .find((provider) => provider.id === (ws.currentProviderId || resolvedProviderId))
    ?.models.find((model) => model.id === (ws.currentModelId || resolvedModelId));
  const supportedThinkingEfforts = supportedThinkingEffortLevels(activeSessionModel);
  const enabledOptInModes = useEnabledOptInModes(activeProviderId);
  const providerModes = activeProvider?.modes ?? EMPTY_PROVIDER_MODES;
  const providerAccessModes = activeProvider?.access_modes ?? EMPTY_PROVIDER_ACCESS_MODES;
  return useMemo(
    () => ({
      agentCatalog,
      resolvedProviderId,
      resolvedModelId,
      resolvedThinkingEffort,
      activeProviderId,
      supportedThinkingEfforts,
      enabledOptInModes,
      providerModes,
      providerAccessModes,
      resolveModelThinkingEffort,
    }),
    [
      activeProviderId,
      agentCatalog,
      enabledOptInModes,
      providerModes,
      providerAccessModes,
      resolveModelThinkingEffort,
      resolvedModelId,
      resolvedProviderId,
      resolvedThinkingEffort,
      supportedThinkingEfforts,
    ],
  );
}

function useAccessControls(ws: WsSession, providerId: string): AccessControls {
  const {
    globalAccessMode,
    isPending: isAccessModePending,
    handleAccessModeChange: handleGlobalAccessModeChange,
  } = useAccessModeSetting(providerId);
  const hasStartedConversation = ws.blocks.length > 0 || ws.runtimeSessionId !== "";
  const accessMode = hasStartedConversation ? ws.accessMode : globalAccessMode;
  const handleAccessModeChange = useCallback(
    (mode: AccessMode): void => {
      if (mode !== accessMode) ws.setAccessMode(mode);
      if (mode !== globalAccessMode) handleGlobalAccessModeChange(mode);
    },
    [accessMode, globalAccessMode, handleGlobalAccessModeChange, ws],
  );
  return useMemo(
    () => ({
      accessMode,
      accessModeDefault: globalAccessMode,
      isAccessModePending,
      handleAccessModeChange,
    }),
    [accessMode, globalAccessMode, handleAccessModeChange, isAccessModePending],
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
  const isClaudeProvider = activeProviderIdOf(ws, resolvedProviderId) === PROVIDER_IDS.CLAUDE_CODE;
  const claudeProfile = useClaudeProfileSelection({
    isClaudeProvider,
    wsSessionId: sessionId,
    sessionProfile: ws.currentProfile,
    onSessionProfileChange: ws.setProfile,
  });
  const runtime = useRuntimeSelection(
    ws,
    effectiveCwd,
    options?.agentCatalogEnabled ?? true,
    isClaudeProvider ? claudeProfile.catalogProfile : undefined,
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
  const codex = useAccessControls(ws, runtime.activeProviderId);
  const handlePermissionModeToggle = usePermissionModeToggle(
    sessionId,
    runtime.activeProviderId,
    runtime.enabledOptInModes,
    runtime.providerModes,
  );
  return useMemo<SessionControls>(
    () => ({
      ws,
      ...worktree,
      selectedBranch,
      setSelectedBranch,
      initializedRef,
      ...runtime,
      handlePermissionModeToggle,
      claudeProfile,
      ...codex,
      initialCwd: effectiveCwd,
    }),
    [
      claudeProfile,
      codex,
      effectiveCwd,
      handlePermissionModeToggle,
      initializedRef,
      runtime,
      selectedBranch,
      worktree,
      ws,
    ],
  );
}
