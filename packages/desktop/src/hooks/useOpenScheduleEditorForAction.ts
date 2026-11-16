import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scheduleActionSearch, type ScheduleActionTarget } from "@/lib/schedules/action-link";

/**
 * Opens the Schedules page with the editor on a new schedule that runs
 * `target.actionId` in `target.featureId` (both preselected; the user picks the
 * timing). Custom actions are scheduled there like any other schedule.
 */
export function useOpenScheduleEditorForAction(): (target: ScheduleActionTarget) => void {
  const navigate = useNavigate();
  return useCallback(
    (target: ScheduleActionTarget): void => {
      void navigate({ to: "/schedules", search: scheduleActionSearch(target) });
    },
    [navigate],
  );
}
