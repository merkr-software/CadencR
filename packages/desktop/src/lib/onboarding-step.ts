/**
 * Onboarding overlay state machine.
 *
 * The current step is persisted as a workspace setting under
 * `onboarding_step` (see `WORKSPACE_ALLOWED_KEYS` in
 * `packages/service/src/domain/settings_allowlist.rs`). A missing value is
 * treated as `"welcome"` so existing installs see the overlay on next open
 * until they either complete it or dismiss it via "Skip onboarding".
 *
 * Steps before `"completed"` are presentation-only: each step writes the next
 * value to settings as the user navigates. `"completed"` is the terminal
 * value that hides the overlay.
 */

export const ONBOARDING_STEPS = [
  "welcome",
  "discover_cli",
  "choose_workspace",
  "pick_agent",
  "preferences",
  "first_prompt",
  "completed",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Steps shown in the overlay UI (everything except the terminal state). */
export const VISIBLE_ONBOARDING_STEPS = ONBOARDING_STEPS.slice(0, -1) as readonly Exclude<
  OnboardingStep,
  "completed"
>[];

export const FIRST_ONBOARDING_STEP: OnboardingStep = "welcome";
export const COMPLETED_ONBOARDING_STEP: OnboardingStep = "completed";

/** Settings key used to persist the current step. */
export const ONBOARDING_STEP_SETTING_KEY = "onboarding_step";

/** Settings key used to persist the default agent provider chosen at step 4. */
export const DEFAULT_AGENT_PROVIDER_SETTING_KEY = "default_agent_provider";

/**
 * Settings key flagging that the cinematic intro animation has played once.
 * The welcome step plays the intro only when this value is missing or the
 * literal string `"false"`; after the animation finishes (or the user clicks
 * to skip) it's set to `"true"` so the user never sees the intro twice.
 */
export const ONBOARDING_INTRO_SHOWN_SETTING_KEY = "onboarding_intro_shown";

/**
 * Coerce an arbitrary value (e.g. from the settings API) into a known step.
 * Unknown / missing values fall back to the first step so the overlay opens
 * on the welcome screen.
 */
export function parseOnboardingStep(value: string | null | undefined): OnboardingStep {
  if (value && (ONBOARDING_STEPS as readonly string[]).includes(value)) {
    return value as OnboardingStep;
  }
  return FIRST_ONBOARDING_STEP;
}

/**
 * Return the next step in the linear flow, or `"completed"` once the last
 * visible step has been passed.
 */
export function nextOnboardingStep(step: OnboardingStep): OnboardingStep {
  const idx = ONBOARDING_STEPS.indexOf(step);
  if (idx < 0 || idx >= ONBOARDING_STEPS.length - 1) return COMPLETED_ONBOARDING_STEP;
  return ONBOARDING_STEPS[idx + 1] as OnboardingStep;
}

/**
 * Return the previous step in the linear flow. The first step has no
 * predecessor; we return it unchanged so the "Back" button can be a no-op
 * disabled control on step 1.
 */
export function previousOnboardingStep(step: OnboardingStep): OnboardingStep {
  const idx = ONBOARDING_STEPS.indexOf(step);
  if (idx <= 0) return FIRST_ONBOARDING_STEP;
  return ONBOARDING_STEPS[idx - 1] as OnboardingStep;
}

/** 1-based position of the step within the visible flow (used by the Stepper). */
export function onboardingStepNumber(step: OnboardingStep): number {
  if (step === COMPLETED_ONBOARDING_STEP) return VISIBLE_ONBOARDING_STEPS.length;
  return ONBOARDING_STEPS.indexOf(step) + 1;
}

export const TOTAL_ONBOARDING_STEPS = VISIBLE_ONBOARDING_STEPS.length;
