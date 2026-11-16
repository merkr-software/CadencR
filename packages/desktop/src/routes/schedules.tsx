import { type ReactElement } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SchedulesView } from "@/components/schedules/SchedulesView";
import { actionTargetFromSearch, parseSchedulesSearch } from "@/lib/schedules/action-link";

export const Route = createFileRoute("/schedules")({
  component: SchedulesRoute,
  validateSearch: parseSchedulesSearch,
});

function SchedulesRoute(): ReactElement {
  const search = Route.useSearch();
  return <SchedulesView actionPreset={actionTargetFromSearch(search)} />;
}
