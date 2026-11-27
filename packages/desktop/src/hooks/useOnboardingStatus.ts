import { useCallback, useMemo } from "react";
import { useGetWorkspaceSetting } from "@/api/generated";
import { useSettingWriter } from "@/hooks/useSetting";
import { translateUi } from "@/lib/i18n/ui";
import { apiErrorCode, isSettingsRepairError } from "@/lib/api-errors";
import {
  COMPLETED_ONBOARDING_STEP,
  ONBOARDING_STEP_SETTING_KEY,
  parseOnboardingStep,
  type OnboardingStep,
} from "@/lib/onboarding-step";

interface UseOnboardingStatusResult {
  step: OnboardingStep;
  isLoading: boolean;
  /** A read (first load or retry) is in flight. */
  isFetching: boolean;
  isPersisting: boolean;
  error: unknown;
  retry: () => Promise<OnboardingStep | undefined>;
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
  const query = useGetWorkspaceSetting(ONBOARDING_STEP_SETTING_KEY, {
    // Show settings repair immediately. The dialog offers an explicit retry.
    query: {
      retry: (failures, error) => failures < 1 && !isSettingsRepairError(apiErrorCode(error)),
    },
  });
  const { setValue, isSaving: isPending } = useSettingWriter(ONBOARDING_STEP_SETTING_KEY);

  const step = parseOnboardingStep(query.data?.value);

  const setStep = useCallback(
    async (next: OnboardingStep): Promise<void> => {
      if (!(await setValue(next))) {
        throw new Error(
          translateUi("onboarding.progress.saveFailed", "Could not save setup progress."),
        );
      }
    },
    [setValue],
  );

  const complete = useCallback(() => setStep(COMPLETED_ONBOARDING_STEP), [setStep]);

  const retry = useCallback(async () => {
    const reading = await query.refetch({ cancelRefetch: false });
    return reading.isSuccess ? parseOnboardingStep(reading.data.value) : undefined;
  }, [query.refetch]);
  const isLoading = query.isLoading;
  const isFetching = query.isFetching;
  return useMemo(
    () => ({
      step,
      isLoading,
      isFetching,
      isPersisting: isPending,
      error: query.error,
      retry,
      isCompleted: step === COMPLETED_ONBOARDING_STEP,
      setStep,
      complete,
    }),
    [step, isLoading, isFetching, isPending, setStep, complete, query.error, retry],
  );
}
