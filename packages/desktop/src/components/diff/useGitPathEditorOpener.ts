import { translateUi } from "@/lib/i18n/ui";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getGetGitPathPrefixQueryOptions } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { gitPathToFeaturePath } from "@/lib/git-paths";
import type { OpenDiffInEditor } from "./OpenDiffInEditorContext";

/**
 * Wrap an editor opener for the Git tab, whose paths are relative to the
 * checkout root: the editor opens paths relative to the feature's directory,
 * which is a subdirectory for a monorepo project.
 */
export function useGitPathEditorOpener(
  featureId: number,
  open: OpenDiffInEditor | undefined,
): OpenDiffInEditor | undefined {
  const queryClient = useQueryClient();
  const openGitPath = useCallback<OpenDiffInEditor>(
    (gitPath, lineNumber, column) => {
      if (!open) return;
      void queryClient
        .ensureQueryData(getGetGitPathPrefixQueryOptions({ feature_id: featureId }))
        .then(({ prefix }) => {
          const featurePath = gitPathToFeaturePath(gitPath, prefix ?? "");
          if (featurePath == null) {
            toast.error(`${gitPath} is outside this project's folder`, {
              description: translateUi(
                "workspace.git.useGitPathEditorOpener.theEditorOnlyOpensFilesUnderPath",
                "The Editor only opens files under {{path}}.",
                { path: prefix },
              ),
            });
            return;
          }
          open(featurePath, lineNumber, column);
        })
        .catch((error: unknown) => {
          toast.error(
            translateUi(
              "workspace.git.useGitPathEditorOpener.couldNotOpenPath",
              "Could not open {{path}}",
              { path: gitPath },
            ),
            {
              description: apiErrorMessage(
                error,
                translateUi(
                  "workspace.git.useGitPathEditorOpener.theProjectSGitRootIsUnavailable",
                  "The project's Git root is unavailable",
                ),
              ),
            },
          );
        });
    },
    [featureId, open, queryClient],
  );
  return open ? openGitPath : undefined;
}
