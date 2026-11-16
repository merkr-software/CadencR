import { ModelSelector } from "@/components/ModelSelector";
import { OnboardingFooter } from "../OnboardingFooter";
import type { OnboardingStepProps } from "../OnboardingOverlay";

/**
 * Step 4 — choose the runtime model the first conversation starts on, plus the
 * model that auto-names sessions. The `session` pick seeds the workspace's
 * last-used selection: from then on every new conversation starts on whatever
 * model the user last prompted with, so there is no default to revisit later.
 *
 * The selector autosaves each pick through its own mutations, so advancing is
 * a plain navigation — there's nothing extra to persist here. Skipping simply
 * leaves the catalog defaults in place.
 */
export function PickAgentStep({
  isPersisting,
  onAdvance,
  onBack,
  onSkipStep,
}: OnboardingStepProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdvance();
      }}
      className="flex flex-col gap-6"
    >
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Choose your agent</h2>
        <p className="text-sm text-muted-foreground">
          Pick the model your first conversation starts on, and the model that auto-names your
          sessions. After that, new conversations reuse the model you last used.
        </p>
      </header>

      <ModelSelector level="global" />

      <OnboardingFooter
        primaryLabel="Continue"
        primaryDisabled={isPersisting}
        onBack={onBack}
        onSkipStep={onSkipStep}
      />
    </form>
  );
}
