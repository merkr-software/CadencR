import { Button } from "@/components/ui/button";

export interface OnboardingFooterProps {
  /** Primary action label (e.g. "Continue", "Choose folder…", "Get started"). */
  primaryLabel: string;
  /** Disable the primary button (e.g. while a mutation is in flight). */
  primaryDisabled?: boolean;
  /** "Back" handler. If `undefined`, the back slot is hidden (used on step 1). */
  onBack?: () => void;
  /** "Skip this step" handler. If `undefined`, the skip slot is hidden. */
  onSkipStep?: () => void;
  /** Custom label for the skip-step action; defaults to "Skip". */
  skipStepLabel?: string;
}

/**
 * Shared footer for onboarding steps. Renders three slots with consistent
 * spacing: Back (left) — Skip step (right of Back) — Primary (far right).
 * Step components compose this so navigation feels identical everywhere.
 * Primary is the submit button of the step's `<form>`, whose `onSubmit` owns
 * the action — a click handler here as well would run it twice.
 */
export function OnboardingFooter({
  primaryLabel,
  primaryDisabled,
  onBack,
  onSkipStep,
  skipStepLabel = "Skip",
}: OnboardingFooterProps) {
  return (
    <div className="flex items-center justify-between gap-3 pt-2">
      <div className="flex items-center gap-2">
        {onBack ? (
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {onSkipStep ? (
          <Button type="button" variant="ghost" size="sm" onClick={onSkipStep}>
            {skipStepLabel}
          </Button>
        ) : null}
        <Button type="submit" disabled={primaryDisabled}>
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}
