import { ModelSelector } from "@/components/ModelSelector";
import { OnboardingFooter } from "../OnboardingFooter";
import type { OnboardingStepProps } from "../OnboardingOverlay";

/**
 * Step 4 — choose the runtime model new sessions use, plus the model that
 * auto-names sessions. Replaces the old provider-only picker: reusing the
 * global `ModelSelector` gives provider *and* model selection for both the
 * `session` runtime and the `auto_name` agent, with the same catalog defaults
 * the rest of the app resolves to.
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
          Pick the runtime model new sessions use, and the model that auto-names your sessions.
          Changes save automatically — you can override any of this later from Settings.
        </p>
      </header>

      <ModelSelector level="global" />

      <OnboardingFooter
        primaryLabel="Continue"
        onPrimary={onAdvance}
        primaryDisabled={isPersisting}
        onBack={onBack}
        onSkipStep={onSkipStep}
      />
    </form>
  );
}
