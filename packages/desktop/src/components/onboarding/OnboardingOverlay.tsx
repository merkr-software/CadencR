import { useCallback, useState } from "react";
import { needsTelemetryDecision, type TelemetryState } from "@/api/telemetry";
import { TelemetryStep } from "./steps/TelemetryStep";
import { apiErrorMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import {
  nextOnboardingStep,
  previousOnboardingStep,
  type OnboardingStep,
} from "@/lib/onboarding-step";
import { Stepper } from "./Stepper";
import { WelcomeStep } from "./steps/WelcomeStep";
import { DiscoverCliStep } from "./steps/DiscoverCliStep";
import { ChooseWorkspaceStep } from "./steps/ChooseWorkspaceStep";
import { PickAgentStep } from "./steps/PickAgentStep";
import { NotificationsStep } from "./steps/NotificationsStep";
import { PreferencesStep } from "./steps/PreferencesStep";
import { FirstPromptStep } from "./steps/FirstPromptStep";

/**
 * Shape passed to each step component. Steps compose `OnboardingFooter` with
 * these handlers so navigation is identical across the flow.
 */
export interface OnboardingStepProps {
  isPersisting: boolean;
  onAdvance: () => void;
  onBack: (() => void) | undefined;
  onSkipStep: () => void;
}

/**
 * Full-window onboarding overlay rendered above the router by `OnboardingGate`.
 * Reads / writes the current step via `useOnboardingStatus`. The workspace stays
 * unmounted until setup and the required privacy decision are complete.
 *
 * Three navigation actions are wired here and forwarded to the visible step:
 * Continue (next step), Skip (next step without doing the step's action),
 * Back (previous step). A top-right "Skip onboarding" link short-circuits the
 * flow to the privacy decision when one is required, otherwise to `completed`.
 */
export function OnboardingOverlay({ telemetryState }: { telemetryState: TelemetryState }) {
  const { step, isPersisting, setStep, complete } = useOnboardingStatus();
  const [skipAfterDecision, setSkipAfterDecision] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigate = useCallback((action: () => Promise<void>): void => {
    setNavigationError(null);
    void action().catch((error: unknown) =>
      setNavigationError(
        apiErrorMessage(error, "Could not save setup progress. Please try again."),
      ),
    );
  }, []);
  const completeOnboarding = useCallback(() => navigate(complete), [navigate, complete]);

  const advance = useCallback(() => {
    navigate(() => setStep(nextOnboardingStep(step)));
  }, [step, setStep, navigate]);

  const back = useCallback(() => {
    navigate(() => setStep(previousOnboardingStep(step)));
  }, [step, setStep, navigate]);

  const skipAll = useCallback(() => {
    if (needsTelemetryDecision(telemetryState)) {
      setSkipAfterDecision(true);
      navigate(() => setStep("telemetry"));
    } else {
      completeOnboarding();
    }
  }, [completeOnboarding, navigate, setStep, telemetryState]);

  // Step 1 has no Back; everywhere else, Back is enabled.
  const onBack = step === "welcome" ? undefined : back;

  const stepProps: OnboardingStepProps = {
    isPersisting,
    onAdvance: advance,
    onBack,
    onSkipStep: advance,
  };

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="inset-0 top-0 left-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background/95 p-0 backdrop-blur-sm sm:max-w-none"
      >
        <DialogTitle className="sr-only">Onboarding</DialogTitle>
        {/* `pt-12` clears the macOS traffic-light buttons, which sit at ~y=12
          inside `titleBarStyle: "hiddenInset"` and would otherwise overlap the
          stepper's top-left "Step X of Y" label. */}
        <header className="flex items-center justify-between gap-4 px-8 pt-12 pb-4 border-b border-border/40">
          <div className="flex-1 max-w-2xl">
            <Stepper step={step} />
          </div>
          <Button
            variant="ghost"
            type="button"
            onClick={skipAll}
            disabled={isPersisting || step === "telemetry"}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Skip onboarding
          </Button>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div
            key={step}
            className="mx-auto w-full max-w-2xl px-8 py-10 animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out"
          >
            {step === "telemetry" ? (
              <TelemetryStep
                state={telemetryState}
                disabled={isPersisting}
                onContinue={skipAfterDecision ? completeOnboarding : advance}
              />
            ) : (
              <StepBody step={step} {...stepProps} />
            )}
          </div>
          {isPersisting ? (
            <p role="status" className="px-8 pb-4 text-sm text-muted-foreground">
              Saving setup progress…
            </p>
          ) : null}
          {navigationError ? (
            <p role="alert" className="px-8 pb-4 text-sm text-destructive">
              {navigationError}
            </p>
          ) : null}
        </main>
      </DialogContent>
    </Dialog>
  );
}

function StepBody({ step, ...props }: OnboardingStepProps & { step: OnboardingStep }) {
  switch (step) {
    case "welcome":
      return <WelcomeStep {...props} />;
    case "discover_cli":
      return <DiscoverCliStep {...props} />;
    case "choose_workspace":
      return <ChooseWorkspaceStep {...props} />;
    case "pick_agent":
      return <PickAgentStep {...props} />;
    case "notifications":
      return <NotificationsStep {...props} />;
    case "preferences":
      return <PreferencesStep {...props} />;
    case "first_prompt":
      return <FirstPromptStep {...props} />;
    case "telemetry":
      return null;
    case "completed":
      // Shouldn't be reachable: OnboardingGate hides the overlay when
      // `isCompleted`. Render nothing rather than throw so a stale render
      // between the mutation success and the unmount doesn't flash an error.
      return null;
  }
}
