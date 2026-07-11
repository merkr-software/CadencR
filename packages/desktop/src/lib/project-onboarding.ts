import { useCallback, useMemo, useRef, useState } from "react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";

/**
 * Workspace setting flagging that the user dismissed the per-project
 * onboarding modal via its "Don't show this again" checkbox. Stored as
 * "true" / "false"; missing/unset means the modal still shows for new
 * projects.
 */
export const PROJECT_ONBOARDING_DISMISSED_SETTING_KEY = "project_onboarding_dismissed";

export interface UseProjectOnboardingDismissedResult {
  dismissed: boolean;
  setDismissed: (next: boolean) => void;
  isLoading: boolean;
}

/**
 * Whether the per-project onboarding modal has been dismissed for good.
 * Defaults to `false` (show the modal) until explicitly turned off.
 */
export function useProjectOnboardingDismissed(): UseProjectOnboardingDismissedResult {
  const setting = useDebouncedSetting(PROJECT_ONBOARDING_DISMISSED_SETTING_KEY, 0);
  const setDismissed = useCallback(
    (next: boolean) => setting.setValue(next ? "true" : "false"),
    [setting.setValue],
  );

  return useMemo(
    () => ({
      dismissed: setting.value === "true",
      setDismissed,
      isLoading: setting.isLoading,
    }),
    [setDismissed, setting.isLoading, setting.value],
  );
}

/** A freshly-created project awaiting its onboarding modal. */
export interface OnboardingProject {
  id: number;
  name: string;
}

export interface UseNewProjectOnboardingResult {
  /** The project whose onboarding modal is open, or null. */
  onboardingProject: OnboardingProject | null;
  /** Open the modal for a just-created project, unless dismissed for good. */
  maybeOnboard: (project: OnboardingProject) => void;
  /** Close the modal. */
  close: () => void;
}

/**
 * Drives the per-project onboarding modal after a project is created. Shared by
 * every create path (sidebar tree + first-run onboarding step) so the trigger
 * logic lives in one place. Reads the dismissed flag through a ref so a "Don't
 * show this again" toggle inside the modal takes effect for the next add
 * without re-subscribing the create mutation.
 */
export function useNewProjectOnboarding(): UseNewProjectOnboardingResult {
  const [onboardingProject, setOnboardingProject] = useState<OnboardingProject | null>(null);
  const { dismissed } = useProjectOnboardingDismissed();
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;

  const maybeOnboard = useCallback((project: OnboardingProject) => {
    if (!dismissedRef.current) setOnboardingProject(project);
  }, []);
  const close = useCallback(() => setOnboardingProject(null), []);

  return useMemo(
    () => ({ onboardingProject, maybeOnboard, close }),
    [onboardingProject, maybeOnboard, close],
  );
}
