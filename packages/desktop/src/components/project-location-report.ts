import { toast } from "sonner";
import type { UpdateProjectResponse } from "@/api/generated";
import { translateUi } from "@/lib/i18n/ui";
import { folderName } from "@/lib/project-location";

export function reportProjectUpdate(response: UpdateProjectResponse) {
  toast.success(
    translateUi("project.location.updated", 'Project "{{name}}" updated', {
      name: response.project.name,
    }),
    {
      description: translateUi("project.location.updatedFolder", "Folder: {{folder}}", {
        folder: folderName(response.project.path),
      }),
    },
  );
  if (response.original_left_at) {
    toast.info(
      translateUi("project.location.originalFolderKept", "The original folder is still in place"),
      {
        description: translateUi(
          "project.location.copiedFolder",
          "It was copied to another disk. Delete {{path}} once you have checked the copy.",
          { path: response.original_left_at },
        ),
        duration: Infinity,
      },
    );
  }
  if (response.warnings.length > 0) {
    toast.warning(
      translateUi(
        "project.location.partialUpdateWarning",
        "Some project data did not follow the folder",
      ),
      {
        description: response.warnings.join("\n"),
        duration: Infinity,
      },
    );
  }
}
