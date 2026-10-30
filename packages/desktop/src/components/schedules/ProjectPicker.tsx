import { useMemo, type ReactElement } from "react";
import type { Project } from "@/api/generated";
import { ProjectBadge } from "@/components/ProjectBadge";
import { PickerPlaceholder, SchedulePicker } from "./SchedulePicker";

export interface ProjectPickerProps {
  projects: Project[];
  value?: number | null;
  onChange: (projectId: number) => void;
}

/** Searchable project list, shared by every kind of schedule target. */
export function ProjectPicker({ projects, value, onChange }: ProjectPickerProps): ReactElement {
  const options = useMemo(
    () =>
      projects.map((project) => ({
        value: project.id,
        label: project.name,
        // The same badge the sidebar uses — a project is recognized by its
        // logo long before its name is read.
        icon: <ProjectBadge projectId={project.id} size="sm" />,
      })),
    [projects],
  );
  if (projects.length === 0) {
    return <PickerPlaceholder>No projects yet — add one first.</PickerPlaceholder>;
  }
  return (
    <SchedulePicker
      ariaLabel="Project"
      options={options}
      value={value}
      placeholder="Pick a project…"
      searchPlaceholder="Search projects…"
      emptyLabel="No matching projects."
      onChange={onChange}
    />
  );
}
