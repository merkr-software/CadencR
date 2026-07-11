import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ProviderIcon } from "@/lib/provider-icons";
import { resolveProviderModelAlias } from "@/lib/provider-model-aliases";
import { cn } from "@/lib/utils";
import {
  RuntimeModelPicker,
  type RuntimeModelPickerModel,
  type RuntimeModelPickerProvider,
} from "@/components/RuntimeModelPicker";
import { ThinkingEffortBars } from "@/components/ThinkingEffortBars";
import {
  nextThinkingEffort,
  thinkingEffortLabel,
  type ThinkingEffortLevel,
} from "@/shared/thinking-effort";
import { ShortcutTooltip } from "../ShortcutTooltip";

export type Model = RuntimeModelPickerModel;
export type Provider = RuntimeModelPickerProvider;

const MODEL_GROUP =
  "inline-flex h-8 items-stretch rounded-md border border-[var(--chip-violet-fg)]/15 bg-[var(--chip-violet-bg)]/12 text-[11px] font-medium text-[var(--chip-violet-soft)] shadow-sm";
const MODEL_SEGMENT = "inline-flex h-full items-center gap-1.5 px-2.5 transition-colors";

interface ModelMetaChipProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentProviderId?: string;
  currentModelId?: string;
  currentModelLabel: string;
  isModelCatalogLoading?: boolean;
  pickerProviders: RuntimeModelPickerProvider[];
  canChangeProvider: boolean;
  onProviderChange?: (providerId: string) => void;
  onModelChange?: (providerId: string, modelId: string) => void;
  currentThinkingEffort?: ThinkingEffortLevel;
  supportedThinkingEfforts: ThinkingEffortLevel[];
  onThinkingEffortChange?: (thinkingEffort?: ThinkingEffortLevel) => void;
  onModelSelected?: () => void;
}

export function ModelMetaChip({
  open,
  onOpenChange,
  currentProviderId,
  currentModelId,
  currentModelLabel,
  isModelCatalogLoading = false,
  pickerProviders,
  canChangeProvider,
  onProviderChange,
  onModelChange,
  currentThinkingEffort,
  supportedThinkingEfforts,
  onThinkingEffortChange,
  onModelSelected,
}: ModelMetaChipProps): ReactNode {
  const selectedThinkingEffort =
    currentThinkingEffort && supportedThinkingEfforts.includes(currentThinkingEffort)
      ? currentThinkingEffort
      : undefined;
  const displayedThinkingEffort = selectedThinkingEffort ?? supportedThinkingEfforts[0];

  const handleThinkingEffortCycle = (): void => {
    if (!supportedThinkingEfforts.length || !onThinkingEffortChange) return;
    onThinkingEffortChange(nextThinkingEffort(supportedThinkingEfforts, currentThinkingEffort));
  };

  return (
    <div className={MODEL_GROUP}>
      {onModelChange ? (
        <ShortcutTooltip label="Open model picker" keys={["cmd", "P"]} disabled={open}>
          <RuntimeModelPicker
            open={open}
            onOpenChange={onOpenChange}
            providers={pickerProviders}
            selectedProviderId={currentProviderId}
            selectedModelId={currentModelId}
            resolveSelectedModelId={resolveProviderModelAlias}
            onAfterSelectClose={onModelSelected}
            onSelect={(providerId, modelId) => {
              if (canChangeProvider && onProviderChange && providerId !== currentProviderId) {
                onProviderChange(providerId);
              }
              onModelChange(providerId, modelId);
            }}
            trigger={
              <ModelButton
                currentProviderId={currentProviderId}
                currentModelLabel={currentModelLabel}
                isModelCatalogLoading={isModelCatalogLoading}
              />
            }
          />
        </ShortcutTooltip>
      ) : (
        <ShortcutTooltip label={`Model: ${currentModelLabel}`}>
          <div
            className={cn(MODEL_SEGMENT, "min-w-0 rounded-md")}
            aria-busy={isModelCatalogLoading}
          >
            <ModelIcon
              providerId={currentProviderId}
              label={currentModelLabel}
              loading={isModelCatalogLoading}
            />
            <span className="truncate text-[11px] leading-none">{currentModelLabel}</span>
          </div>
        </ShortcutTooltip>
      )}

      {supportedThinkingEfforts.length > 0 && onThinkingEffortChange && displayedThinkingEffort && (
        <ThinkingEffortSegment
          displayedThinkingEffort={displayedThinkingEffort}
          selectedThinkingEffort={selectedThinkingEffort}
          supportedThinkingEfforts={supportedThinkingEfforts}
          onCycle={handleThinkingEffortCycle}
        />
      )}
    </div>
  );
}

interface ModelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  currentProviderId?: string;
  currentModelLabel: string;
  isModelCatalogLoading?: boolean;
}

const ModelButton = forwardRef<HTMLButtonElement, ModelButtonProps>(function ModelButton(
  { currentProviderId, currentModelLabel, isModelCatalogLoading, className, ...buttonProps },
  ref,
): ReactNode {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-label={isModelCatalogLoading ? "Loading model catalog" : undefined}
      disabled={isModelCatalogLoading}
      className={cn(
        MODEL_SEGMENT,
        "min-w-0 rounded-l-md hover:bg-[var(--chip-violet-bg)]/16 disabled:cursor-wait disabled:opacity-80",
        className,
      )}
    >
      <ModelIcon
        providerId={currentProviderId}
        label={currentModelLabel}
        loading={isModelCatalogLoading}
      />
      <span className="truncate text-[11px] leading-none">{currentModelLabel}</span>
      {!isModelCatalogLoading && <ChevronDownIcon className="size-3 shrink-0" />}
    </button>
  );
});

function ModelIcon({
  providerId,
  label,
  loading,
}: {
  providerId?: string;
  label: string;
  loading?: boolean;
}): ReactNode {
  return loading ? (
    <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
  ) : (
    <ProviderIcon providerId={providerId} alt={label} className="size-3.5 rounded-sm shrink-0" />
  );
}

interface ThinkingEffortSegmentProps {
  displayedThinkingEffort: ThinkingEffortLevel;
  selectedThinkingEffort?: ThinkingEffortLevel;
  supportedThinkingEfforts: ThinkingEffortLevel[];
  onCycle: () => void;
}

function ThinkingEffortSegment({
  displayedThinkingEffort,
  selectedThinkingEffort,
  supportedThinkingEfforts,
  onCycle,
}: ThinkingEffortSegmentProps): ReactNode {
  return (
    <>
      <div className="w-px bg-[var(--chip-violet-soft)]/15" aria-hidden="true" />
      <ShortcutTooltip
        label={`Thinking effort: ${thinkingEffortLabel(displayedThinkingEffort)}`}
        keys={["cmd", "T"]}
      >
        <button
          type="button"
          onClick={onCycle}
          className={cn(
            MODEL_SEGMENT,
            "rounded-r-md px-2 text-[var(--chip-violet-soft)] hover:bg-[var(--chip-violet-bg)]/10",
          )}
          aria-label="Cycle thinking effort"
        >
          <ThinkingEffortBars
            levels={supportedThinkingEfforts}
            value={selectedThinkingEffort}
            compact
          />
        </button>
      </ShortcutTooltip>
    </>
  );
}
