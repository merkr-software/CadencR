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
        error: apiErrorMessage(error, "Could not read ignored language suggestions"),
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
  const error =
    ignored.error ??
    (reset.error ? apiErrorMessage(reset.error, "Could not restore language suggestions") : null);
  if (!ignored.languages.length && !error) return null;
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        Suggestions ignored for {ignored.languages.length} language
        {ignored.languages.length === 1 ? "" : "s"} in this project.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={reset.isPending || settings.isPending || settings.isError || !!ignored.error}
        onClick={() => reset.mutate()}
      >
        {reset.isPending ? "Restoring suggestions…" : "Show language suggestions again"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
