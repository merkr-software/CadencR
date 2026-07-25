import { useNavigate } from "@tanstack/react-router";
import { useGlobalShortcutById } from "@/hooks/useShortcut";

export function SchedulesShortcut(): null {
  const navigate = useNavigate();
  useGlobalShortcutById("open-schedules", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void navigate({ to: "/schedules" });
  });
  return null;
}
