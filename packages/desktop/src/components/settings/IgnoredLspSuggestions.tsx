import { useUiTranslation } from "@/lib/i18n/ui";
import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  getGetProjectSettingsQueryKey,
  setProjectSetting,
  useGetProjectSettings,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";

const ignoredSchema = z.array(z.string());

/** Reverses the project-wide Ignore action without editing the settings JSON. */
export function IgnoredLspSuggestions({ projectId }: { projectId: number }) {
  const { t } = useUiTranslation();
  const settings = useGetProjectSettings(projectId);
  const client = useQueryClient();
  const raw = settings.data?.find((entry) => entry.key === "editor_lsp_ignored_languages")?.value;
  const ignored = useMemo(() => {
    try {
      return {
        languages: ignoredSchema.parse(raw ? (JSON.parse(raw) as unknown) : []),
        error: null,
      };
    } catch (error) {
      return {
        languages: [],
        error,
      };
    }
  }, [raw]);
  const reset = useMutation({
    mutationFn: () =>
      setProjectSetting(projectId, { key: "editor_lsp_ignored_languages", value: "[]" }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: getGetProjectSettingsQueryKey(projectId) }),
        client.invalidateQueries({ queryKey: ["/api/lsp/resolve"] }),
      ]);
    },
  });
  const error = ignored.error
    ? apiErrorMessage(
        ignored.error,
        t(
          "workspace.editor.ignoredLspSuggestions.readFailed",
          "Could not read ignored language suggestions",
        ),
      )
    : reset.error
      ? apiErrorMessage(
          reset.error,
          t(
            "workspace.editor.ignoredLspSuggestions.restoreFailed",
            "Could not restore language suggestions",
          ),
        )
      : null;
  if (!ignored.languages.length && !error) return null;
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        {t("workspace.editor.ignoredLspSuggestions.summary", {
          count: ignored.languages.length,
          defaultValue_one: "Suggestions ignored for {{count, number}} language in this project.",
          defaultValue_other:
            "Suggestions ignored for {{count, number}} languages in this project.",
        })}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={reset.isPending || settings.isPending || settings.isError || !!ignored.error}
        onClick={() => reset.mutate()}
      >
        {reset.isPending
          ? t("workspace.editor.ignoredLspSuggestions.restoring", "Restoring suggestions…")
          : t("workspace.editor.ignoredLspSuggestions.restore", "Show language suggestions again")}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
