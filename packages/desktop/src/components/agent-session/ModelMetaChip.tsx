import { ChevronDownIcon, Loader2Icon, ZapIcon } from "lucide-react";
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
const LOADING_CATALOG_LABEL = "Loading model catalog";

function modelLabelFor(
  selection: RuntimeSelection,
  pickerProviders: RuntimeModelPickerProvider[],
): string {
  const models =
    pickerProviders.find((provider) => provider.id === selection.providerId)?.models ?? [];
  const resolvedId = resolveProviderModelAlias(selection.providerId, selection.modelId, models);
  return models.find((model) => model.id === resolvedId)?.label ?? selection.modelId;
}

// Rem CQ so the label tracks text scale (same idea as GitTabToggle).
const COMPACT_LABELS = "@max-[40rem]:hidden";
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
        <ShortcutTooltip label="Open model picker" keys={modelPickerKeys} disabled={open}>
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
        <ShortcutTooltip label={`Model: ${modelLabel}`}>
          <div
            className={cn(MODEL_SEGMENT, "min-w-0 rounded-md")}
            aria-busy={isLoading}
            aria-label={isLoading ? LOADING_CATALOG_LABEL : undefined}
          >
            <ModelIcon providerId={selection?.providerId} label={modelLabel} loading={isLoading} />
            <SlidingText text={modelLabel} className="max-w-[160px]" />
          </div>
        </ShortcutTooltip>
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
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-label={isLoading ? LOADING_CATALOG_LABEL : undefined}
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
  const thinkingKeys = useShortcutKeys("agent-thinking");
  return (
    <>
      {!instrument && <div className="w-px bg-[var(--chip-violet-soft)]/15" aria-hidden="true" />}
      <ShortcutTooltip
        label={`Thinking effort: ${thinkingEffortLabel(displayedThinkingEffort)}`}
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
          aria-label="Cycle thinking effort"
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
              {selectedThinkingEffort ? thinkingEffortLabel(selectedThinkingEffort) : "Effort"}
            </span>
          )}
        </button>
      </ShortcutTooltip>
    </>
  );
}

function FastModeSegment({
  enabled,
  pending,
  onToggle,
  instrument = false,
}: {
  enabled: boolean;
  pending: boolean;
  onToggle: () => void;
  instrument?: boolean;
}): ReactNode {
  if (instrument) {
    return <FastModeInstrument enabled={enabled} pending={pending} onToggle={onToggle} />;
  }
  const stateLabel = enabled ? "On" : "Off";
  return (
    <>
      <div className="w-px bg-[var(--chip-violet-soft)]/15" aria-hidden="true" />
      <ShortcutTooltip label={`Fast mode: ${stateLabel}`}>
        <button
          type="button"
          onClick={onToggle}
          disabled={pending}
          aria-label={`Turn fast mode ${enabled ? "off" : "on"}`}
          aria-pressed={enabled}
          aria-busy={pending}
          data-state={enabled ? "on" : "off"}
          className={cn(
            MODEL_SEGMENT,
            // Model chip stays on --chip-violet-* (DESIGN.md). Never theme
            // --primary here — on Frost that paints cyan/blue into a violet
            // control. ON is a charged violet cell: dense fill, bright soft
            // ink, inset hairline + outer glow so it reads as lit, not tinted.
            "rounded-r-md px-2 disabled:cursor-wait",
            enabled
              ? "bg-[var(--chip-violet-bg)]/70 font-semibold text-[var(--chip-violet-soft)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--chip-violet-soft)_65%,transparent),0_0_22px_-1px_color-mix(in_oklch,var(--chip-violet-bg)_75%,transparent)] hover:bg-[var(--chip-violet-bg)]/80"
              : "text-[var(--chip-violet-soft)]/35 hover:bg-[var(--chip-violet-bg)]/10 hover:text-[var(--chip-violet-soft)]/70",
          )}
        >
          {pending ? (
            <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <ZapIcon
              className={cn(
                "size-3 shrink-0 transition-[filter,color] duration-150",
                enabled &&
                  "fill-current text-[var(--chip-violet-soft)] drop-shadow-[0_0_6px_color-mix(in_oklch,var(--chip-violet-soft)_85%,transparent)]",
              )}
              aria-hidden="true"
            />
          )}
          <span aria-hidden="true" className={cn(COMPACT_LABELS, enabled && "tracking-wide")}>
            Fast
          </span>
        </button>
      </ShortcutTooltip>
    </>
  );
}

/**
 * Fast mode in the composer's instrument row: a lit amber bolt when on, a
 * quiet outline when off — no charged chip.
 */
function FastModeInstrument({
  enabled,
  pending,
  onToggle,
}: {
  enabled: boolean;
  pending: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <ShortcutTooltip label={`Fast mode: ${enabled ? "On" : "Off"}`}>
      <button
        type="button"
        onClick={onToggle}
        disabled={pending}
        aria-label={`Turn fast mode ${enabled ? "off" : "on"}`}
        aria-pressed={enabled}
        aria-busy={pending}
        data-state={enabled ? "on" : "off"}
        className={cn(
          "composer-instrument gap-1 disabled:cursor-wait",
          enabled ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {pending ? (
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <ZapIcon
            className={cn(
              "size-3.5 shrink-0",
              enabled && "fill-current text-[var(--acc-yellow)] composer-fast-lit",
            )}
            aria-hidden="true"
          />
        )}
        <span aria-hidden="true" className={INSTRUMENT_LABELS}>
          Fast
        </span>
      </button>
    </ShortcutTooltip>
  );
}
