import { useMemo, useState, type ReactElement } from "react";
import { BotIcon, ChevronDownIcon, CircleDashedIcon, Loader2Icon, XIcon } from "lucide-react";
import { useAgentCatalog, type RuntimeProviderOption } from "@/api/agentRuntime";
import { ModelMetaChip, type Provider } from "@/components/agent-session/ModelMetaChip";
import { RuntimeModelPicker } from "@/components/RuntimeModelPicker";
import { useEnabledOptInModes } from "@/hooks/useEnabledOptInModes";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";
import { apiErrorMessage } from "@/lib/api-errors";
import { resolveProviderModelAlias } from "@/lib/provider-model-aliases";
import { getVisibleModes, nextProviderMode } from "@/lib/provider-modes";
import type { VirtualSkillConfig } from "@/lib/virtual-skill-config";
import { availableCatalogProviders } from "@/shared/models";
import { nextThinkingEffort, supportedThinkingEffortLevels } from "@/shared/thinking-effort";
import { ModeControl } from "./ModeControl";
import { useWizardShortcut } from "./useSkillWizardFocus";

interface VirtualSkillAgentControlsProps {
  config: VirtualSkillConfig;
  onChange: (config: VirtualSkillConfig) => void;
  /** The wizard holds focus: the composer's model, mode and effort chords land here. */
  shortcutsActive: boolean;
}

/**
 * Provider, model, thinking effort and autonomy mode of the sessions a skill
 * spawns — the composer's own model and mode instruments, driven from the
 * wizard's configuration instead of the live session (whose settings stay
 * untouched). Until a model — or a mode — is picked the agent chooses,
 * following the skill's own guidance (a read-only reviewer on another model,
 * for instance). Each control sits in a composer group, so the composer's
 * hairlines separate them.
 */
export function VirtualSkillAgentControls({
  config,
  onChange,
  shortcutsActive,
}: VirtualSkillAgentControlsProps): ReactElement {
  const catalog = useAgentCatalog();
  const providers = useMemo(
    () => availableCatalogProviders(catalog.data?.providers),
    [catalog.data?.providers],
  );
  const pickerProviders = useMemo(
    (): Provider[] =>
      providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        disabled: false,
        models: provider.models,
      })),
    [providers],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  useWizardShortcut(
    "agent-model-picker",
    () => setPickerOpen(true),
    shortcutsActive && !catalog.isLoading && !catalog.isError,
  );

  if (catalog.isError) {
    return (
      <p data-composer-group className="px-1 text-[11px] text-destructive" role="alert">
        {apiErrorMessage(catalog.error, "Could not load the installed agents.")}
      </p>
    );
  }
  if (catalog.isLoading) {
    return (
      <span data-composer-group className="flex items-center" role="status">
        <span className="composer-instrument gap-1.5 text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
          Loading agents…
        </span>
      </span>
    );
  }

  const pick = (providerId: string, modelId: string): void => {
    const sameProvider = providerId === config.target?.providerId;
    onChange({
      ...config,
      target: { providerId, modelId },
      // Effort levels are per model, modes per provider. A model alone pins no
      // mode: the agent keeps choosing it until the user does.
      thinking: undefined,
      permissionMode: sameProvider ? config.permissionMode : undefined,
    });
  };

  if (!config.target) {
    return (
      <span data-composer-group className="flex items-center">
        <RuntimeModelPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          providers={pickerProviders}
          resolveSelectedModelId={resolveProviderModelAlias}
          onSelect={pick}
          align="start"
          trigger={
            <button
              type="button"
              className="composer-instrument min-w-0 gap-1.5 text-muted-foreground hover:text-foreground"
              aria-label="Model: the agent picks. Choose a model"
            >
              <BotIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">Agent picks the model</span>
              <ChevronDownIcon className="size-3 shrink-0 opacity-50" aria-hidden />
            </button>
          }
        />
      </span>
    );
  }

  return (
    <PinnedAgentControls
      config={config}
      shortcutsActive={shortcutsActive}
      target={config.target}
      providers={providers}
      pickerProviders={pickerProviders}
      pickerOpen={pickerOpen}
      onPickerOpenChange={setPickerOpen}
      onPick={pick}
      onChange={onChange}
    />
  );
}

interface PinnedAgentControlsProps extends VirtualSkillAgentControlsProps {
  target: NonNullable<VirtualSkillConfig["target"]>;
  providers: RuntimeProviderOption[];
  pickerProviders: Provider[];
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  onPick: (providerId: string, modelId: string) => void;
}

function PinnedAgentControls({
  config,
  shortcutsActive,
  target,
  providers,
  pickerProviders,
  pickerOpen,
  onPickerOpenChange,
  onPick,
  onChange,
}: PinnedAgentControlsProps): ReactElement {
  const provider = providers.find((entry) => entry.id === target.providerId);
  const models = provider?.models ?? [];
  const resolvedModelId = resolveProviderModelAlias(target.providerId, target.modelId, models);
  const model = models.find((entry) => entry.id === resolvedModelId);
  const thinkingLevels = supportedThinkingEffortLevels(model);
  useWizardShortcut(
    "agent-thinking",
    () => {
      const thinking = nextThinkingEffort(thinkingLevels, config.thinking);
      if (thinking) onChange({ ...config, thinking });
    },
    shortcutsActive && thinkingLevels.length > 0,
  );

  return (
    <>
      <SkillModeControl
        provider={provider}
        providerId={target.providerId}
        permissionMode={config.permissionMode}
        onChange={(permissionMode) => onChange({ ...config, permissionMode })}
        shortcutsActive={shortcutsActive}
      />
      <span data-composer-group className="flex items-center">
        <ModelMetaChip
          variant="instrument"
          open={pickerOpen}
          onOpenChange={onPickerOpenChange}
          selection={target}
          pickerProviders={pickerProviders}
          // Provider and model are written together from the one selection.
          canChangeProvider={false}
          onModelChange={onPick}
          currentThinkingEffort={config.thinking}
          supportedThinkingEfforts={thinkingLevels}
          onThinkingEffortChange={(thinking) => onChange({ ...config, thinking })}
        />
        <button
          type="button"
          className="composer-instrument aspect-square justify-center px-0 text-muted-foreground hover:text-foreground"
          onClick={() =>
            onChange({
              ...config,
              target: undefined,
              thinking: undefined,
              permissionMode: undefined,
            })
          }
          aria-label="Let the agent pick the model"
          title="Let the agent pick the model"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      </span>
    </>
  );
}

/**
 * The spawned session's autonomy mode. Unset, the agent picks it (a reviewer
 * stays read-only); Shift+Tab walks "agent picks" → each mode → "agent picks".
 */
function SkillModeControl({
  provider,
  providerId,
  permissionMode,
  onChange,
  shortcutsActive,
}: {
  provider: RuntimeProviderOption | undefined;
  providerId: string;
  permissionMode: VirtualSkillConfig["permissionMode"];
  onChange: (mode: VirtualSkillConfig["permissionMode"]) => void;
  shortcutsActive: boolean;
}): ReactElement | null {
  const enabledOptInModes = useEnabledOptInModes(providerId);
  const modes = getVisibleModes(providerId, enabledOptInModes, provider?.modes);
  const modeKeys = useShortcutLabel("agent-permission-mode");
  const cycle = (): void => {
    const first = modes[0]?.id;
    if (!permissionMode) return onChange(first);
    const next = nextProviderMode(providerId, permissionMode, enabledOptInModes, provider?.modes);
    onChange(next === first ? undefined : next);
  };
  useWizardShortcut("agent-permission-mode", cycle, shortcutsActive && modes.length >= 2);
  if (modes.length < 2) return null;

  return (
    <span data-composer-group className="flex items-center">
      {permissionMode ? (
        <ModeControl
          providerId={providerId}
          permissionMode={permissionMode}
          enabledOptInModes={enabledOptInModes}
          providerModes={provider?.modes}
          onSelect={onChange}
          onToggle={cycle}
        />
      ) : (
        <button
          type="button"
          className="composer-instrument min-w-0 gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={cycle}
          aria-label="Mode: the agent picks. Choose a mode"
          title={`The agent picks the mode. Click or ${modeKeys} to choose one`}
        >
          <CircleDashedIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">Agent picks the mode</span>
        </button>
      )}
    </span>
  );
}
