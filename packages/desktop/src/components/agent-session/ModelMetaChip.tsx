import { useUiTranslation } from "@/lib/i18n/ui";
import { FastModeSegment } from "./ModelFastMode";
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
import { SlidingText } from "@/components/SlidingText";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { ThinkingEffortBars } from "@/components/ThinkingEffortBars";
import {
  nextThinkingEffort,
  thinkingEffortLabel,
  type ThinkingEffortLevel,
} from "@/shared/thinking-effort";
import type { RuntimeSelection } from "@/shared/models";
import { ShortcutTooltip } from "../ShortcutTooltip";

export type Model = RuntimeModelPickerModel;
export type Provider = RuntimeModelPickerProvider;

const MODEL_GROUP =
  "inline-flex h-8 items-stretch rounded-md border border-[var(--chip-violet-fg)]/15 bg-[var(--chip-violet-bg)]/12 text-[11px] font-medium text-[var(--chip-violet-soft)] shadow-sm";
const MODEL_SEGMENT = "inline-flex h-full items-center gap-1.5 px-2.5 transition-colors";
// Inside the composer card the model control is a run of plain instruments:
// neutral ink, no border, wash or tint — the provider's icon is the only
// color, so the row reads as one calm strip (DESIGN.md › Composer).
const MODEL_INSTRUMENT_GROUP = "inline-flex min-w-0 items-center gap-0.5";

function modelLabelFor(
  selection: RuntimeSelection,
  pickerProviders: RuntimeModelPickerProvider[],
): string {
  const models =
    pickerProviders.find((provider) => provider.id === selection.providerId)?.models ?? [];
  const resolvedId = resolveProviderModelAlias(selection.providerId, selection.modelId, models);
  return models.find((model) => model.id === resolvedId)?.label ?? selection.modelId;
}

// In the composer these answer to the instrument row they sit in (either of
// the card's two rows, which share its width): labels hold until the card
// itself gets genuinely tight.
const INSTRUMENT_LABELS = "@max-[26rem]:hidden";

interface ModelMetaChipProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The confirmed runtime pair, or `null` while it is unknown. A single object
   * so the icon and the label cannot disagree — they now derive from the same
   * source rather than from two independently-updated props.
   */
  selection: RuntimeSelection | null;
  pickerProviders: RuntimeModelPickerProvider[];
  canChangeProvider: boolean;
  onProviderChange?: (providerId: string) => void;
  onModelChange?: (providerId: string, modelId: string) => void;
  currentThinkingEffort?: ThinkingEffortLevel;
  supportedThinkingEfforts: ThinkingEffortLevel[];
  onThinkingEffortChange?: (thinkingEffort?: ThinkingEffortLevel) => void;
  supportsFastMode?: boolean;
  fastMode?: boolean;
  isFastModePending?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  onModelSelected?: () => void;
  /** `instrument`: borderless, for the composer card's instrument row. */
  variant?: "chip" | "instrument";
}

export function ModelMetaChip({
  open,
  onOpenChange,
  selection,
  pickerProviders,
  canChangeProvider,
  onProviderChange,
  onModelChange,
  currentThinkingEffort,
  supportedThinkingEfforts,
  onThinkingEffortChange,
  supportsFastMode = false,
  fastMode = false,
  isFastModePending = false,
  onFastModeChange,
  onModelSelected,
  variant = "chip",
}: ModelMetaChipProps): ReactNode {
  const { t } = useUiTranslation();
  const selectedThinkingEffort =
    currentThinkingEffort && supportedThinkingEfforts.includes(currentThinkingEffort)
      ? currentThinkingEffort
      : undefined;
  const displayedThinkingEffort = selectedThinkingEffort ?? supportedThinkingEfforts[0];
  const modelPickerKeys = useShortcutKeys("agent-model-picker");
  const isLoading = selection === null;
  const modelLabel = selection ? modelLabelFor(selection, pickerProviders) : "";

  const handleThinkingEffortCycle = (): void => {
    if (!supportedThinkingEfforts.length || !onThinkingEffortChange) return;
    onThinkingEffortChange(nextThinkingEffort(supportedThinkingEfforts, currentThinkingEffort));
  };

  return (
    <div className={variant === "instrument" ? MODEL_INSTRUMENT_GROUP : MODEL_GROUP}>
      {onModelChange ? (
        <ShortcutTooltip
          label={t("conversation.stream.modelMetaChip.openModelPicker", "Open model picker")}
          keys={modelPickerKeys}
          disabled={open}
        >
          <RuntimeModelPicker
            open={open}
            onOpenChange={onOpenChange}
            providers={pickerProviders}
            selectedProviderId={selection?.providerId}
            selectedModelId={selection?.modelId}
            resolveSelectedModelId={resolveProviderModelAlias}
            onAfterSelectClose={onModelSelected}
            onSelect={(providerId, modelId) => {
              if (canChangeProvider && onProviderChange && providerId !== selection?.providerId) {
                onProviderChange(providerId);
              }
              onModelChange(providerId, modelId);
            }}
            trigger={
              <ModelButton
                providerId={selection?.providerId}
                modelLabel={modelLabel}
                isLoading={isLoading}
                instrument={variant === "instrument"}
              />
            }
          />
        </ShortcutTooltip>
      ) : (
        <ReadOnlyModelChip
          providerId={selection?.providerId}
          label={modelLabel}
          isLoading={isLoading}
        />
      )}

      {supportedThinkingEfforts.length > 0 && onThinkingEffortChange && displayedThinkingEffort && (
        <ThinkingEffortSegment
          displayedThinkingEffort={displayedThinkingEffort}
          selectedThinkingEffort={selectedThinkingEffort}
          supportedThinkingEfforts={supportedThinkingEfforts}
          onCycle={handleThinkingEffortCycle}
          trailingSegment={supportsFastMode && !!onFastModeChange}
          instrument={variant === "instrument"}
        />
      )}
      {supportsFastMode && onFastModeChange && (
        <FastModeSegment
          enabled={fastMode}
          pending={isFastModePending}
          onToggle={() => onFastModeChange(!fastMode)}
          instrument={variant === "instrument"}
        />
      )}
    </div>
  );
}

function ReadOnlyModelChip({
  providerId,
  label: modelLabel,
  isLoading,
}: {
  providerId?: string;
  label: string;
  isLoading: boolean;
}) {
  const { t } = useUiTranslation();
  return (
    <ShortcutTooltip
      label={t("conversation.stream.modelMetaChip.selectedModel", "Model: {{modelLabel}}", {
        modelLabel,
      })}
    >
      <div
        className={cn(MODEL_SEGMENT, "min-w-0 rounded-md")}
        aria-busy={isLoading}
        aria-label={
          isLoading
            ? t("conversation.stream.modelMetaChip.loadingCatalog", "Loading model catalog")
            : undefined
        }
      >
        <ModelIcon providerId={providerId} label={modelLabel} loading={isLoading} />
        <SlidingText text={modelLabel} className="max-w-[160px]" />
      </div>
    </ShortcutTooltip>
  );
}

interface ModelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  providerId?: string;
  modelLabel: string;
  isLoading?: boolean;
  instrument?: boolean;
}

const ModelButton = forwardRef<HTMLButtonElement, ModelButtonProps>(function ModelButton(
  { providerId, modelLabel, isLoading, instrument = false, className, ...buttonProps },
  ref,
): ReactNode {
  const { t } = useUiTranslation();
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-label={
        isLoading
          ? t("conversation.stream.modelMetaChip.loadingCatalog", "Loading model catalog")
          : undefined
      }
      disabled={isLoading}
      className={cn(
        instrument
          ? "composer-instrument min-w-0 gap-1.5 text-foreground disabled:cursor-wait"
          : cn(MODEL_SEGMENT, "min-w-0 rounded-l-md hover:bg-[var(--chip-violet-bg)]/16"),
        "disabled:cursor-wait disabled:opacity-80",
        className,
      )}
    >
      <ModelIcon providerId={providerId} label={modelLabel} loading={isLoading} />
      <SlidingText text={modelLabel} className="max-w-[160px]" />
      {!isLoading && (
        <ChevronDownIcon className={cn("size-3 shrink-0", instrument && "opacity-50")} />
      )}
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
  trailingSegment: boolean;
  /** Composer instrument row: neutral bars, the effort named beside them. */
  instrument?: boolean;
}

function ThinkingEffortSegment({
  displayedThinkingEffort,
  selectedThinkingEffort,
  supportedThinkingEfforts,
  onCycle,
  trailingSegment,
  instrument = false,
}: ThinkingEffortSegmentProps): ReactNode {
  const { t } = useUiTranslation();
  const thinkingKeys = useShortcutKeys("agent-thinking");
  return (
    <>
      {!instrument && <div className="w-px bg-[var(--chip-violet-soft)]/15" aria-hidden="true" />}
      <ShortcutTooltip
        label={t(
          "conversation.stream.modelMetaChip.thinkingEffort",
          "Thinking effort: {{effort}}",
          { effort: thinkingEffortLabel(displayedThinkingEffort) },
        )}
        keys={thinkingKeys}
      >
        <button
          type="button"
          onClick={onCycle}
          className={
            instrument
              ? "composer-instrument gap-1.5 text-muted-foreground hover:text-foreground"
              : cn(
                  MODEL_SEGMENT,
                  "px-2 text-[var(--chip-violet-soft)] hover:bg-[var(--chip-violet-bg)]/10",
                  !trailingSegment && "rounded-r-md",
                )
          }
          aria-label={t(
            "conversation.stream.modelMetaChip.cycleThinkingEffort",
            "Cycle thinking effort",
          )}
        >
          <ThinkingEffortBars
            levels={supportedThinkingEfforts}
            value={selectedThinkingEffort}
            compact
            tone={instrument ? "neutral" : "violet"}
          />
          {instrument && (
            <span aria-hidden="true" className={INSTRUMENT_LABELS}>
              {/* Unset means the provider's own default — never claim a level. */}
              {selectedThinkingEffort
                ? thinkingEffortLabel(selectedThinkingEffort)
                : t("conversation.stream.modelMetaChip.effort", "Effort")}
            </span>
          )}
        </button>
      </ShortcutTooltip>
    </>
  );
}
