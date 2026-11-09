import { useCallback, useMemo } from "react";
import { useGetWorkspaceSetting } from "@/api/generated";
import { useSettingWriter } from "@/hooks/useSetting";
import {
  COMPLETED_ONBOARDING_STEP,
  ONBOARDING_STEP_SETTING_KEY,
  parseOnboardingStep,
  type OnboardingStep,
} from "@/lib/onboarding-step";

interface UseOnboardingStatusResult {
  step: OnboardingStep;
  isLoading: boolean;
  isPersisting: boolean;
  error: unknown;
  retry: () => void;
  isCompleted: boolean;
  setStep: (next: OnboardingStep) => Promise<void>;
  /** Convenience: jump straight to `completed` (used by "Skip onboarding"). */
  complete: () => Promise<void>;
}

/**
 * Read + persist the first-run onboarding step.
 *
 * Persistence flows through the shared settings writer: the step moves once
 * the backend confirms it, and a failed save toasts and rejects so the overlay
 * can say so in place.
 */
export function useOnboardingStatus(): UseOnboardingStatusResult {
  const query = useGetWorkspaceSetting(ONBOARDING_STEP_SETTING_KEY);
  const { setValue, isSaving: isPending } = useSettingWriter(ONBOARDING_STEP_SETTING_KEY);

  const step = parseOnboardingStep(query.data?.value);

  const setStep = useCallback(
    async (next: OnboardingStep): Promise<void> => {
      if (!(await setValue(next))) throw new Error("Could not save setup progress.");
    },
    [setValue],
  );

  const complete = useCallback(() => setStep(COMPLETED_ONBOARDING_STEP), [setStep]);

  const retry = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);
  const isLoading = query.isLoading;
  return useMemo(
    () => ({
      step,
      isLoading,
      isPersisting: isPending,
      error: query.error,
      retry,
      isCompleted: step === COMPLETED_ONBOARDING_STEP,
      setStep,
      complete,
    }),
    [step, isLoading, isPending, setStep, complete, query.error, retry],
  );
}
