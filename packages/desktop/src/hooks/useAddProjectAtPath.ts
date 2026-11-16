import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetProjectSettingsQueryKey,
  getListProjectsQueryKey,
  useCreateProject,
  useSetProjectSetting,
  type Project,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { PROJECT_COLORS } from "@/lib/project-colors";

/** A project's default name: its folder's name. */
export function projectNameFromPath(folder: string): string {
  return folder.split("/").filter(Boolean).pop() ?? folder;
}

/**
 * Adds `folder` as a project (the sidebar, the palette, `cadencr add`): the
 * folder's name, then a palette color. Resolves with the project the service
 * created; a failed create rejects, a failed color only warns (the project
 * exists). The per-project onboarding dialog belongs to the sidebar, which
 * opens it itself; the palette and `cadencr add` go straight to the project.
 */
export function useAddProjectAtPath(): (folder: string) => Promise<Project> {
  const queryClient = useQueryClient();
  const { mutateAsync: createProject } = useCreateProject();
  const { mutateAsync: setProjectSetting } = useSetProjectSetting();
  return useCallback(
    async (folder: string) => {
      const project = await createProject({
        data: { name: projectNameFromPath(folder), path: folder },
      });
      await queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      const color = PROJECT_COLORS[project.id % PROJECT_COLORS.length];
      try {
        await setProjectSetting({ id: project.id, data: { key: "color", value: color } });
        await queryClient.invalidateQueries({
          queryKey: getGetProjectSettingsQueryKey(project.id),
        });
      } catch (error) {
        toast.error(`Could not save project setting: ${apiErrorMessage(error, "Unknown error")}`);
      }
      return project;
    },
    [createProject, queryClient, setProjectSetting],
  );
}
