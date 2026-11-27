import { type ReactElement } from "react";
import { createLazyFileRoute } from "@tanstack/react-router";
import { SchedulesView } from "@/components/schedules/SchedulesView";
import { actionTargetFromSearch } from "@/lib/schedules/action-link";

export const Route = createLazyFileRoute("/schedules")({
  component: SchedulesRoute,
});

function SchedulesRoute(): ReactElement {
  const search = Route.useSearch();
  return <SchedulesView actionPreset={actionTargetFromSearch(search)} />;
}
