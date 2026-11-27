import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, type ReactElement, type ReactNode } from "react";
import { Columns3Icon, Loader2Icon, MinusIcon, PlusIcon } from "lucide-react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { AGENTS_PER_ROW_MAX, AGENTS_PER_ROW_MIN } from "@/components/UnifiedAgentsPerRowSetting";

interface UnifiedAgentsPerRowStepperProps {
  value: number;
  isLoading: boolean;
  isSaving: boolean;
  onChange: (value: number) => void;
}

export const UnifiedAgentsPerRowStepper = memo(function UnifiedAgentsPerRowStepper({
  value,
  isLoading,
  isSaving,
  onChange,
}: UnifiedAgentsPerRowStepperProps): ReactElement {
  const { t } = useUiTranslation();
  const busy = isLoading || isSaving;
  // A maximum, not a promise: the grid drops columns when cards would get
  // too narrow to read.
  return (
    <ShortcutTooltip
      label={t(
        "agents.overview.columns.limit",
        "Up to {{count}} per row — fewer when the window is narrow",
        { count: value },
      )}
      alignRight
    >
      <div
        role="group"
        aria-label={t(
          "agents.unifiedAgentsPerRowStepper.maximumAgentsPerRow",
          "Maximum agents per row",
        )}
        className="titlebar-no-drag inline-flex h-9 items-center overflow-hidden rounded-lg border border-border/70 bg-card/80"
      >
        <Columns3Icon aria-hidden="true" className="mx-2 size-3.5 text-muted-foreground" />
        <StepperButton
          label={t(
            "agents.unifiedAgentsPerRowStepper.decreaseAgentsPerRow",
            "Decrease agents per row",
          )}
          disabled={busy || value <= AGENTS_PER_ROW_MIN}
          onClick={() => onChange(Math.max(AGENTS_PER_ROW_MIN, value - 1))}
        >
          <MinusIcon className="size-3" />
        </StepperButton>
        <span className="flex h-9 min-w-6 items-center justify-center font-mono text-[11.5px] font-semibold text-foreground tabular-nums">
          {busy ? (
            <Loader2Icon
              aria-label={t(
                "agents.unifiedAgentsPerRowStepper.savingAgentsPerRow",
                "Saving agents per row",
              )}
              className="size-3 animate-spin"
            />
          ) : (
            value
          )}
        </span>
        <StepperButton
          label={t(
            "agents.unifiedAgentsPerRowStepper.increaseAgentsPerRow",
            "Increase agents per row",
          )}
          disabled={busy || value >= AGENTS_PER_ROW_MAX}
          onClick={() => onChange(Math.min(AGENTS_PER_ROW_MAX, value + 1))}
        >
          <PlusIcon className="size-3" />
        </StepperButton>
      </div>
    </ShortcutTooltip>
  );
});

function StepperButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-9 w-7 rounded-none text-muted-foreground hover:bg-accent/70 hover:text-foreground"
    >
      {children}
    </Button>
  );
}
