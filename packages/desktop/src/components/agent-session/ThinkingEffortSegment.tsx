import { CheckIcon } from "lucide-react";
import { useUiTranslation } from "@/lib/i18n/ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuTrigger,
} from "@/components/PhoneSheetMenu";
import { ThinkingEffortBars } from "@/components/ThinkingEffortBars";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { cn } from "@/lib/utils";
import { thinkingEffortLabel, type ThinkingEffortLevel } from "@/shared/thinking-effort";
import { ShortcutTooltip } from "../ShortcutTooltip";

/** A segment of the model chip (its non-instrument variant). */
export const MODEL_SEGMENT = "inline-flex h-full items-center gap-1.5 px-2.5 transition-colors";
// In the composer these answer to the instrument row they sit in (either of
// the card's two rows, which share its width): labels hold until the card
// itself gets genuinely tight.
export const INSTRUMENT_LABELS = "@max-[26rem]:hidden";

interface ThinkingEffortSegmentProps {
  displayedThinkingEffort: ThinkingEffortLevel;
  selectedThinkingEffort?: ThinkingEffortLevel;
  supportedThinkingEfforts: ThinkingEffortLevel[];
  onCycle: () => void;
  /** Picks a level directly: the phone layout's sheet. */
  onChange: (level: ThinkingEffortLevel) => void;
  trailingSegment: boolean;
  /** Composer instrument row: neutral bars, the effort named beside them. */
  instrument?: boolean;
}

/**
 * Thinking effort. A click cycles the levels on desktop (as its shortcut does);
 * in the phone layout a tap opens a sheet listing every level, since cycling
 * blind costs a finger several taps and hides where it lands.
 */
export function ThinkingEffortSegment({
  displayedThinkingEffort,
  selectedThinkingEffort,
  supportedThinkingEfforts,
  onCycle,
  onChange,
  trailingSegment,
  instrument = false,
}: ThinkingEffortSegmentProps): ReactNode {
  const { t } = useUiTranslation();
  const thinkingKeys = useShortcutKeys("agent-thinking");
  const phone = useIsMobile();
  const button = (
    <EffortButton
      instrument={instrument}
      trailingSegment={trailingSegment}
      levels={supportedThinkingEfforts}
      selected={selectedThinkingEffort}
      onClick={phone ? undefined : onCycle}
      aria-label={
        phone
          ? t("conversation.stream.modelMetaChip.thinkingEffortTitle", "Thinking effort")
          : t("conversation.stream.modelMetaChip.cycleThinkingEffort", "Cycle thinking effort")
      }
    />
  );
  return (
    <>
      {!instrument && <div className="w-px bg-[var(--chip-violet-soft)]/15" aria-hidden="true" />}
      <ShortcutTooltip
        label={t(
          "conversation.stream.modelMetaChip.thinkingEffort",
          "Thinking effort: {{effort}}",
          {
            effort: thinkingEffortLabel(displayedThinkingEffort),
          },
        )}
        keys={thinkingKeys}
      >
        {phone ? (
          <ThinkingEffortMenu
            levels={supportedThinkingEfforts}
            selected={selectedThinkingEffort}
            onChange={onChange}
            trigger={button}
          />
        ) : (
          button
        )}
      </ShortcutTooltip>
    </>
  );
}

interface EffortButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  instrument: boolean;
  trailingSegment: boolean;
  levels: ThinkingEffortLevel[];
  selected?: ThinkingEffortLevel;
}

const EffortButton = forwardRef<HTMLButtonElement, EffortButtonProps>(function EffortButton(
  { instrument, trailingSegment, levels, selected, className, ...buttonProps },
  ref,
): ReactElement {
  const { t } = useUiTranslation();
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      className={cn(
        instrument
          ? "composer-instrument gap-1.5 text-muted-foreground hover:text-foreground"
          : cn(
              MODEL_SEGMENT,
              "px-2 text-[var(--chip-violet-soft)] hover:bg-[var(--chip-violet-bg)]/10",
              !trailingSegment && "rounded-r-md",
            ),
        className,
      )}
    >
      <ThinkingEffortBars
        levels={levels}
        value={selected}
        compact
        tone={instrument ? "neutral" : "violet"}
      />
      {instrument && (
        <span aria-hidden="true" className={INSTRUMENT_LABELS}>
          {/* Unset means the provider's own default — never claim a level. */}
          {selected
            ? thinkingEffortLabel(selected)
            : t("conversation.stream.modelMetaChip.effort", "Effort")}
        </span>
      )}
    </button>
  );
});

function ThinkingEffortMenu({
  levels,
  selected,
  onChange,
  trigger,
}: {
  levels: ThinkingEffortLevel[];
  selected?: ThinkingEffortLevel;
  onChange: (level: ThinkingEffortLevel) => void;
  trigger: ReactElement;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <AdaptiveMenu>
      <AdaptiveMenuTrigger asChild>{trigger}</AdaptiveMenuTrigger>
      <AdaptiveMenuContent
        side="top"
        align="start"
        sheetTitle={t("conversation.stream.modelMetaChip.thinkingEffortTitle", "Thinking effort")}
        sheetTitleVisible
      >
        {levels.map((level) => (
          <AdaptiveMenuItem
            key={level}
            aria-current={level === selected ? "true" : undefined}
            onSelect={() => {
              if (level !== selected) onChange(level);
            }}
          >
            <span aria-hidden="true" className="flex w-10 shrink-0 justify-center">
              <ThinkingEffortBars levels={levels} value={level} compact tone="neutral" />
            </span>
            <span className="min-w-0 flex-1">{thinkingEffortLabel(level)}</span>
            {level === selected && <CheckIcon className="size-4 shrink-0" />}
          </AdaptiveMenuItem>
        ))}
      </AdaptiveMenuContent>
    </AdaptiveMenu>
  );
}
