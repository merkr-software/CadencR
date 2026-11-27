import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import {
  TOTAL_ONBOARDING_STEPS,
  VISIBLE_ONBOARDING_STEPS,
  onboardingStepNumber,
  type OnboardingStep,
} from "@/lib/onboarding-step";

/**
 * Header strip showing "Step X / N" plus a labelled tick per step. Active and
 * completed steps are filled; future steps are dim. Pure presentation — the
 * overlay owns navigation.
 */
export function Stepper({ step }: { step: OnboardingStep }) {
  const { t } = useUiTranslation();
  const stepLabels = {
    welcome: t("onboarding.stepper.welcome", "Welcome"),
    discover_cli: t("onboarding.stepper.detectClis", "Detect CLIs"),
    choose_workspace: t("onboarding.stepper.chooseFolder", "Choose folder"),
    pick_agent: t("onboarding.stepper.agentAndModel", "Agent & model"),
    notifications: t("onboarding.stepper.notifications", "Notifications"),
    preferences: t("onboarding.stepper.preferences", "Preferences"),
    telemetry: t("onboarding.stepper.privacy", "Privacy"),
    first_prompt: t("onboarding.stepper.getStarted", "Get started"),
  } satisfies Record<Exclude<OnboardingStep, "completed">, string>;
  const current = onboardingStepNumber(step);

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="text-xs text-muted-foreground tabular-nums">
        {t("onboarding.stepper.progress", "Step {{step}} of {{total}}", {
          step: current,
          total: TOTAL_ONBOARDING_STEPS,
        })}
      </div>
      <div className="flex gap-2">
        {VISIBLE_ONBOARDING_STEPS.map((s, idx) => {
          const isPast = idx + 1 < current;
          const isCurrent = idx + 1 === current;
          return (
            <div
              key={s}
              className={cn("flex-1 flex flex-col gap-1.5", "text-[11px] uppercase tracking-wide")}
              aria-current={isCurrent ? "step" : undefined}
            >
              <div
                className={cn(
                  "h-1 rounded-full transition-colors",
                  isPast || isCurrent ? "bg-primary" : "bg-muted",
                )}
              />
              <span
                className={cn(
                  isCurrent ? "text-foreground" : "text-muted-foreground",
                  !isPast && !isCurrent && "opacity-60",
                )}
              >
                {stepLabels[s]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
