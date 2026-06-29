import { memo, type ReactElement, type ReactNode } from "react";
import { Loader2Icon, MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AGENTS_PER_ROW_MAX, AGENTS_PER_ROW_MIN } from "@/components/UnifiedAgentsPerRowSetting";

interface UnifiedAgentsPerRowStepperProps {
  value: number;
  isLoading: boolean;
  isSaving: boolean;
  onChange: (value: number) => void;
}

const FILTER_LABEL_CLASS =
  "pr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

export const UnifiedAgentsPerRowStepper = memo(function UnifiedAgentsPerRowStepper({
  value,
  isLoading,
  isSaving,
  onChange,
}: UnifiedAgentsPerRowStepperProps): ReactElement {
  const busy = isLoading || isSaving;
  return (
    <div
      role="group"
      aria-label="Agents per row"
      className="inline-flex h-9 items-center gap-1 rounded-xl bg-transparent px-1.5"
    >
      <span className={FILTER_LABEL_CLASS}>Per row</span>
      <div className="inline-flex overflow-hidden rounded-md border border-border/70 bg-card/80 font-mono">
        <StepperButton
          label="Decrease agents per row"
          disabled={busy || value <= AGENTS_PER_ROW_MIN}
          onClick={() => onChange(Math.max(AGENTS_PER_ROW_MIN, value - 1))}
        >
          <MinusIcon className="size-3" />
        </StepperButton>
        <span className="flex h-8 min-w-7 items-center justify-center text-[11.5px] font-semibold text-foreground">
          {busy ? (
            <Loader2Icon aria-label="Saving agents per row" className="size-3 animate-spin" />
          ) : (
            value
          )}
        </span>
        <StepperButton
          label="Increase agents per row"
          disabled={busy || value >= AGENTS_PER_ROW_MAX}
          onClick={() => onChange(Math.min(AGENTS_PER_ROW_MAX, value + 1))}
        >
          <PlusIcon className="size-3" />
        </StepperButton>
      </div>
    </div>
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
      className="h-8 w-8 rounded-none text-muted-foreground hover:bg-accent/70 hover:text-foreground"
    >
      {children}
    </Button>
  );
}
