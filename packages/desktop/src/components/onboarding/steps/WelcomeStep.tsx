import { useCallback, useState } from "react";
import { Sparkles } from "lucide-react";
import { useGetWorkspaceSetting } from "@/api/generated";
import { ONBOARDING_INTRO_SHOWN_SETTING_KEY } from "@/lib/onboarding-step";
import { useAnimationsEnabled } from "@/lib/animations/animations-setting";
import { Switch } from "@/components/ui/switch";
import { OnboardingFooter } from "../OnboardingFooter";
import type { OnboardingStepProps } from "../OnboardingOverlay";
import { WelcomeIntro } from "./WelcomeIntro";

/**
 * Step 1 — short welcome copy explaining what Cadencr is. No action other
 * than acknowledging and moving on. We deliberately omit a "Skip" button
 * here because skipping the welcome is equivalent to "Skip onboarding",
 * which already lives in the overlay header.
 *
 * On the very first open of the onboarding we play `WelcomeIntro` over the
 * step content. The intro persists `onboarding_intro_shown=true` once it
 * finishes; we keep a local `introClosed` boolean so the intro stays mounted
 * for the full fade-out animation (the cache update would otherwise flip
 * `persistedShown` to true mid-fade and unmount the intro instantly).
 */
export function WelcomeStep({ isPersisting, onAdvance, onBack }: OnboardingStepProps) {
  const introQuery = useGetWorkspaceSetting(ONBOARDING_INTRO_SHOWN_SETTING_KEY);
  const [introClosed, setIntroClosed] = useState(false);
  const onIntroComplete = useCallback(() => setIntroClosed(true), []);
  const animations = useAnimationsEnabled();

  // Wait for the query to resolve before deciding — otherwise we'd flash the
  // welcome copy for one frame on first launch before the intro mounts.
  const persistedShown = introQuery.data?.value === "true";
  const shouldShowIntro = !introQuery.isLoading && !persistedShown && !introClosed;

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onAdvance();
        }}
        className="flex flex-col gap-8"
      >
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">Welcome to Cadencr</h1>
          <p className="text-base text-muted-foreground leading-relaxed">
            One workspace for Claude, OpenCode, and Codex. We&apos;ll take a minute to detect your
            installed agent CLIs, pick a project folder, and choose a default agent — then drop you
            straight into your first prompt.
          </p>
        </div>

        <label
          htmlFor="onboarding-animations-toggle"
          className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border bg-card/40 p-4"
        >
          <div className="flex items-start gap-3">
            <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-[var(--acc-purple)]">
              <Sparkles className="size-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">Fluid animations</div>
              <p className="mt-0.5 text-xs text-muted-foreground leading-snug">
                Smooth fades and slides across menus, dialogs, and panels. You can change this any
                time in Settings → Appearance.
              </p>
            </div>
          </div>
          <Switch
            id="onboarding-animations-toggle"
            checked={animations.enabled}
            onCheckedChange={animations.setEnabled}
            disabled={animations.isLoading}
            aria-label="Enable fluid animations"
          />
        </label>

        <OnboardingFooter
          primaryLabel="Get started"
          primaryDisabled={isPersisting}
          onBack={onBack}
        />
      </form>

      {shouldShowIntro ? <WelcomeIntro onComplete={onIntroComplete} /> : null}
    </>
  );
}
