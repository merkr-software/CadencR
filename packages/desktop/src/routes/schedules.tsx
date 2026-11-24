import { createFileRoute } from "@tanstack/react-router";
import { parseSchedulesSearch } from "@/lib/schedules/action-link";

/** The schedules page's search; the page is in `schedules.lazy.tsx`. */
export const Route = createFileRoute("/schedules")({
  validateSearch: parseSchedulesSearch,
});
