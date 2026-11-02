import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ScheduleActionTarget } from "@/lib/schedules/action-link";

/**
 * Follows a `/schedules?action=…` link: opens the editor on a new schedule for
 * that action once, then drops the params so a reload or a back-navigation
 * doesn't reopen it.
 */
export function useActionPresetLink(
  preset: ScheduleActionTarget | null,
  open: (preset: ScheduleActionTarget) => void,
): void {
  const navigate = useNavigate();
  // The route rebuilds `preset` every render; only a different link is a new
  // request.
  const key = preset ? `${preset.projectId}:${preset.featureId ?? ""}:${preset.actionId}` : null;
  const latest = useRef({ preset, open });
  latest.current = { preset, open };

  useEffect(() => {
    const { preset, open } = latest.current;
    if (key === null || !preset) return;
    open(preset);
    void navigate({ to: "/schedules", search: {}, replace: true });
  }, [key, navigate]);
}
