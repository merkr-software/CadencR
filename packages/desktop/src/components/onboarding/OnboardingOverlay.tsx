import { useCallback } from "react";
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
 * Reads / writes the current step via `useOnboardingStatus`. The app continues
 * to mount behind the overlay so closing it is instant — no re-fetch storm.
 *
 * Three navigation actions are wired here and forwarded to the visible step:
 * Continue (next step), Skip (next step without doing the step's action),
 * Back (previous step). A top-right "Skip onboarding" link short-circuits the
 * whole flow to `completed`.
 */
export function OnboardingOverlay() {
  const { step, isPersisting, setStep, complete } = useOnboardingStatus();

  const advance = useCallback(() => {
    void setStep(nextOnboardingStep(step));
  }, [step, setStep]);

  const back = useCallback(() => {
    void setStep(previousOnboardingStep(step));
  }, [step, setStep]);

  const skipAll = useCallback(() => {
    void complete();
  }, [complete]);

  // Step 1 has no Back; everywhere else, Back is enabled.
  const onBack = step === "welcome" ? undefined : back;

  const stepProps: OnboardingStepProps = {
    isPersisting,
    onAdvance: advance,
    onBack,
    onSkipStep: advance,
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Onboarding"
    >
      {/* `pt-12` clears the macOS traffic-light buttons, which sit at ~y=12
          inside `titleBarStyle: "hiddenInset"` and would otherwise overlap the
          stepper's top-left "Step X of Y" label. */}
      <header className="flex items-center justify-between gap-4 px-8 pt-12 pb-4 border-b border-border/40">
        <div className="flex-1 max-w-2xl">
          <Stepper step={step} />
        </div>
        <button
          type="button"
          onClick={skipAll}
          disabled={isPersisting}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          Skip onboarding
        </button>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div
          key={step}
          className="mx-auto w-full max-w-2xl px-8 py-10 animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out"
        >
          <StepBody step={step} {...stepProps} />
        </div>
      </main>
    </div>
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
    case "preferences":
      return <PreferencesStep {...props} />;
    case "first_prompt":
      return <FirstPromptStep {...props} />;
    case "completed":
      // Shouldn't be reachable: OnboardingGate hides the overlay when
      // `isCompleted`. Render nothing rather than throw so a stale render
      // between the mutation success and the unmount doesn't flash an error.
      return null;
  }
}
