import type { SessionConfigControls } from "./types";
import { forwardRef, memo, useState, type ReactNode } from "react";
import { AgentTodoList } from "../AgentTodoList";
import type { WorktreeMode } from "@/lib/worktree-mode";
import type { TodoItem } from "@/types/agent";
import type { ThinkingEffortLevel } from "@/shared/thinking-effort";
import type { PermissionMode } from "@/types/permission-mode";
import type { AccessMode } from "@/types/access-mode";
import type {
  RuntimeProviderAccessModeOption,
  RuntimeProviderModeOption,
} from "@/api/agentRuntime";
import type { ClaudeCodeProfile } from "@/api/agentRuntime";
import type { RuntimeSelection } from "@/shared/models";
import { ModelMetaChip, type Model, type Provider } from "./ModelMetaChip";
import { useInstrumentPlacement } from "../composer/InstrumentPlacement";
import type { InstrumentSlot } from "../composer/instrument-layout";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";
import {
  MetaBarLeadingChips,
  MetaBarTrailingGroup,
  useMetaBarDerivedState,
} from "./meta-bar-sections";
import {
  useMetaBarInput,
  useMetaBarForwardRef,
  useMetaBarContainerClassName,
} from "./meta-bar-context";

export interface MetaBarProps {
  sessionConfigControls?: SessionConfigControls;
  showAutoScrollChip: boolean;
  autoScrollEnabled: boolean;
  onToggleAutoScroll: () => void;
  permissionMode?: PermissionMode;
  onPermissionModeToggle?: () => void;
  /**
   * Per-provider opt-in modes the user has unlocked via provider settings.
   * E.g. enabling "Allow BypassPermissions" for Claude Code adds
   * `"bypassPermissions"` to this list when the active provider is Claude.
   * Modes flagged `optIn: true` in the catalog are filtered out unless they
   * appear here.
   */
  enabledOptInModes?: PermissionMode[];
  providerModes?: readonly RuntimeProviderModeOption[];
  providerAccessModes?: readonly RuntimeProviderAccessModeOption[];
  accessMode?: AccessMode;
  accessModeDefault?: AccessMode;
  isAccessModePending?: boolean;
  onAccessModeChange?: (mode: AccessMode) => void;
  showWorktreeChip: boolean;
  /**
   * Branch/worktree behavior picker (Branch chip + explicit mode menu). The
   * chip renders only when the embedder supplies the project id, mode, and
   * both setters.
   */
  worktreeProjectId?: number;
  worktreeDefaultBranch?: string;
  worktreeProjectPath?: string;
  worktreeMode?: WorktreeMode;
  onWorktreeModeChange?: (mode: WorktreeMode) => void;
  worktreeSelectedBranch?: string | null;
  onWorktreeBranchChange?: (next: string | null) => void;
  onProviderChange?: (providerId: string) => void;
  /**
   * Called when the user picks a model from the inline picker. The picker
   * always knows both the provider and the model the user just chose, so we
   * pass both — the parent must not read provider state from the WS store
   * here (no-optimistic-updates rule means it would be stale right after a
   * sibling provider change).
   */
  onModelChange?: (providerId: string, modelId: string) => void;
  currentThinkingEffort?: ThinkingEffortLevel;
  supportedThinkingEfforts?: ThinkingEffortLevel[];
  onThinkingEffortChange?: (thinkingEffort?: ThinkingEffortLevel) => void;
  supportsFastMode?: boolean;
  fastMode?: boolean;
  isFastModePending?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  showClaudeProfileSelector?: boolean;
  claudeProfile?: string;
  claudeProfiles?: ClaudeCodeProfile[];
  claudeProfilesLoading?: boolean;
  claudeProfilesError?: boolean;
  onClaudeProfileChange?: (profile: string) => void;
  activeClaudeProfile?: string;
  showReadOnlyModel?: boolean;
  /** The confirmed runtime pair, or `null` while it is unknown (loading state). */
  currentSelection: RuntimeSelection | null;
  models: Model[];
  providers?: Provider[];
  canChangeProvider?: boolean;
  todos?: TodoItem[] | null;
  runtimeSessionId?: string;
  /** Feature (conversation) id — enables the Info chip's "Sync from CLI" button. */
  featureId?: number;
  /** WS store key — used to merge synced events into the live conversation. */
  wsSessionId?: string;
  projectPath?: string;
  isRunning?: boolean;
  onPause?: () => void;
  onModelSelected?: () => void;
  /**
   * Layout variant. Only the vertical padding differs: `"standalone"` tightens
   * it so the bar can sit on its own inside a bordered container.
   */
  variant?: "session" | "standalone";
  /**
   * Which half of the bar to render. The session composer renders the
   * `instruments` (autonomy, model, access, session config) inside its card
   * and the `utilities` (auto-scroll, todos, info) on a quiet strip above it;
   * `all` keeps the original single row.
   */
  section?: MetaBarSection;
  /** Jump straight to a mode (the instrument mode menu). */
  onPermissionModeSet?: (mode: PermissionMode) => void;
  /** Why the active mode won't hold with the current model, if it won't. */
  modeIncompatibleReason?: string | null;
}

export type MetaBarSection = "all" | "instruments" | "utilities";

export interface MetaBarHandle {
  openModelPicker: () => void;
}

const MetaBarImpl = forwardRef<MetaBarHandle, MetaBarProps>(function MetaBar(props, ref) {
  const input = useMetaBarInput(props);
  const [internalModelPickerOpen, setInternalModelPickerOpen] = useState(false);
  const displayProviderId = input.currentSelection?.providerId;

  useMetaBarForwardRef(ref, setInternalModelPickerOpen);
  const section = props.section ?? "all";
  const containerClassName = useMetaBarContainerClassName(props.variant ?? "session", section);

  const {
    pickerProviders,
    displayMode,
    shouldShowModel,
    hasAccessMode,
    hasProfileSelector,
    hasTrailingGroup,
  } = useMetaBarDerivedState(props, displayProviderId);

  // Inside a composer card each instrument group takes its own slot in the
  // card's instrument rows; elsewhere they share this bar.
  const placement = useInstrumentPlacement();
  const placed = section === "instruments" ? placement : null;
  const place = (slot: InstrumentSlot, node: ReactNode): ReactNode =>
    placed ? placed(slot, node) : node;

  const content = (
    <>
      {place(
        "mode",
        <MetaBarLeadingChips
          section={section}
          providerId={displayProviderId}
          permissionMode={props.permissionMode}
          enabledOptInModes={props.enabledOptInModes}
          providerModes={props.providerModes}
          onPermissionModeSet={props.onPermissionModeSet}
          modeIncompatibleReason={props.modeIncompatibleReason}
          showAutoScrollChip={input.showAutoScrollChip}
          autoScrollEnabled={input.autoScrollEnabled}
          onToggleAutoScroll={input.onToggleAutoScroll}
          displayMode={displayMode}
          onPermissionModeToggle={props.onPermissionModeToggle}
          showWorktreeChip={input.showWorktreeChip}
          worktreeProjectId={input.worktreeProjectId}
          worktreeDefaultBranch={input.worktreeDefaultBranch}
          worktreeProjectPath={input.worktreeProjectPath}
          worktreeMode={input.worktreeMode}
          onWorktreeModeChange={input.onWorktreeModeChange}
          worktreeSelectedBranch={input.worktreeSelectedBranch}
          onWorktreeBranchChange={input.onWorktreeBranchChange}
        />,
      )}

      {shouldShowModel &&
        section !== "utilities" &&
        place(
          "model",
          <ModelMetaChip
            variant={section === "instruments" ? "instrument" : "chip"}
            open={internalModelPickerOpen}
            onOpenChange={setInternalModelPickerOpen}
            selection={input.currentSelection}
            pickerProviders={pickerProviders}
            canChangeProvider={input.canChangeProvider}
            onProviderChange={input.onProviderChange}
            onModelChange={input.onModelChange}
            currentThinkingEffort={input.currentThinkingEffort}
            supportedThinkingEfforts={input.supportedThinkingEfforts}
            onThinkingEffortChange={input.onThinkingEffortChange}
            supportsFastMode={props.supportsFastMode ?? false}
            fastMode={props.fastMode ?? false}
            isFastModePending={props.isFastModePending ?? false}
            onFastModeChange={props.onFastModeChange}
            onModelSelected={input.onModelSelected}
          />,
        )}

      {section !== "instruments" && input.todos && input.todos.length > 0 && (
        <AgentTodoList todos={input.todos} chipClass={META_BAR_CHIP} />
      )}

      {hasTrailingGroup &&
        place(
          "access",
          trailingGroup(props, input, {
            section,
            hasProfileSelector,
            hasAccessMode,
            displayProviderId,
          }),
        )}
    </>
  );
  return placed ? content : <div className={containerClassName}>{content}</div>;
});

/** Memoized: it sits beside the agent stream, whose every delta re-renders its parents. */
export const MetaBar = memo(MetaBarImpl);

/** The access / session-config group (and, outside the composer, the info chip). */
function trailingGroup(
  props: MetaBarProps,
  input: ReturnType<typeof useMetaBarInput>,
  state: {
    section: MetaBarSection;
    hasProfileSelector: boolean;
    hasAccessMode: boolean;
    displayProviderId: string | undefined;
  },
): ReactNode {
  return (
    <MetaBarTrailingGroup
      section={state.section}
      sessionConfigControls={props.sessionConfigControls}
      hasProfileSelector={state.hasProfileSelector}
      hasAccessMode={state.hasAccessMode}
      claudeProfile={input.claudeProfile}
      claudeProfiles={input.claudeProfiles}
      claudeProfilesLoading={input.claudeProfilesLoading}
      claudeProfilesError={input.claudeProfilesError}
      onClaudeProfileChange={input.onClaudeProfileChange}
      activeClaudeProfile={props.activeClaudeProfile}
      accessMode={props.accessMode}
      accessModeDefault={input.accessModeDefault}
      isAccessModePending={input.isAccessModePending}
      onAccessModeChange={input.onAccessModeChange}
      displayProviderId={state.displayProviderId}
      providerAccessModes={input.providerAccessModes}
      runtimeSessionId={input.runtimeSessionId}
      featureId={input.featureId}
      wsSessionId={input.wsSessionId}
      projectPath={input.projectPath}
      isRunning={input.isRunning}
      onPause={input.onPause}
    />
  );
}
