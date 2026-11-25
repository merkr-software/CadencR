import { useUiTranslation } from "@/lib/i18n/ui";
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
  const { t } = useUiTranslation();
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
    return (
      <PickerPlaceholder>
        {t("schedules.picker.noProjects", "No projects yet — add one first.")}
      </PickerPlaceholder>
    );
  }
  return (
    <SchedulePicker
      ariaLabel={t("schedules.editor.project", "Project")}
      searchLabel={t("schedules.picker.searchProject", "Search project")}
      options={options}
      value={value}
      placeholder={t("schedules.picker.chooseProject", "Pick a project…")}
      searchPlaceholder={t("schedules.picker.searchProjectsPlaceholder", "Search projects…")}
      emptyLabel={t("schedules.picker.noMatchingProjects", "No matching projects.")}
      onChange={onChange}
    />
  );
}
