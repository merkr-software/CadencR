import { useCallback, useMemo } from "react";
import { useGetWorkspaceSetting } from "@/api/generated";
import { useSetWorkspaceSettingWithCache } from "@/hooks/useSetWorkspaceSettingWithCache";
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
 * Persistence flows through `useSetWorkspaceSettingWithCache` so the
 * mutation, post-success cache patch, and error toast are factored out and
 * shared with the other onboarding writers (intro-shown flag, default
 * agent provider).
 */
export function useOnboardingStatus(): UseOnboardingStatusResult {
  const query = useGetWorkspaceSetting(ONBOARDING_STEP_SETTING_KEY);
  const { setValue, isPending } = useSetWorkspaceSettingWithCache(ONBOARDING_STEP_SETTING_KEY);

  const step = parseOnboardingStep(query.data?.value);

  const setStep = useCallback((next: OnboardingStep): Promise<void> => setValue(next), [setValue]);

  const complete = useCallback(() => setValue(COMPLETED_ONBOARDING_STEP), [setValue]);

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
