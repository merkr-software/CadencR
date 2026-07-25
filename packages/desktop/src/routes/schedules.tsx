import { type ReactElement } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SchedulesView } from "@/components/schedules/SchedulesView";

export const Route = createFileRoute("/schedules")({
  component: SchedulesRoute,
});

function SchedulesRoute(): ReactElement {
  return <SchedulesView />;
}
