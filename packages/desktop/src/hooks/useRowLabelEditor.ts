import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useListFeatures, useUpdateFeatureLabel, type Feature } from "@/api/generated";
import type { FeatureLabelEditing } from "@/components/ProjectFeatureRowParts";
import { apiErrorMessage } from "@/lib/api-errors";
import { normalizeLabel, uniqueLabels } from "@/lib/feature-labels";
import { invalidateFeatureQueries } from "@/lib/featureUpdated";

const NO_FEATURES: Feature[] = [];

/**
 * The inline label editor of a conversation row outside its project, as a
 * project row has it: suggests the labels of the conversation's project,
 * read only while editing.
 */
export function useRowLabelEditor(feature: Feature): {
  editor: FeatureLabelEditing | undefined;
  start: () => void;
} {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { data: projectFeatures = NO_FEATURES } = useListFeatures(
    { project_id: feature.project_id, include_archived: true },
    // Unsubscribed too while idle: the tree keeps this list live, and every
    // refetch would otherwise re-render each of the project's rows here.
    { query: { enabled: editing, subscribed: editing } },
  );
  const suggestions = useMemo(() => uniqueLabels(projectFeatures), [projectFeatures]);
  const { mutate, isPending } = useUpdateFeatureLabel({
    mutation: {
      onSuccess: (_data, variables) => {
        setEditing(false);
        invalidateFeatureQueries(variables.id, ["label"]);
      },
      onError: (error) => toast.error(apiErrorMessage(error, "Failed to update feature label")),
    },
  });
  const currentLabel = feature.label ?? "";
  const start = useCallback((): void => {
    setDraft(currentLabel);
    setEditing(true);
  }, [currentLabel]);
  const editor = useMemo<FeatureLabelEditing | undefined>(() => {
    if (!editing) return undefined;
    return {
      draft,
      suggestions,
      isSaving: isPending,
      onDraftChange: setDraft,
      onSave: (override) => {
        const normalized = normalizeLabel(override ?? draft);
        if (normalizeLabel(currentLabel) === normalized) setEditing(false);
        else mutate({ id: feature.id, data: { label: normalized } });
      },
      onCancel: () => setEditing(false),
    };
  }, [currentLabel, draft, editing, feature.id, isPending, mutate, suggestions]);
  return { editor, start };
}
