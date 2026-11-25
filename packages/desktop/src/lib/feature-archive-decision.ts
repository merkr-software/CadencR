import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import type { QueryClient } from "@tanstack/react-query";
import {
  getGetFeatureArchivePreviewQueryOptions,
  getIsFeatureEmptyQueryOptions,
  type ArchivePreview,
  type Feature,
  type IsEmptyResponse,
} from "@/api/generated";

export type FeatureArchiveAction = "archive" | "delete";

type FeatureArchiveRelationPreview = Pick<ArchivePreview, "has_relations">;

export function getFeatureArchiveAction(
  feature: Feature,
  empty: boolean,
  hasRelations = false,
): FeatureArchiveAction {
  if (feature.status === "archived") return "delete";
  return empty && !hasRelations ? "delete" : "archive";
}

export function getPendingFeatureArchiveAction(args: {
  feature: Feature | undefined;
  emptyResponse: IsEmptyResponse | undefined;
  isCheckingEmpty: boolean;
  hasEmptyCheckError: boolean;
  relationPreview?: FeatureArchiveRelationPreview;
  isCheckingRelations?: boolean;
  hasRelationCheckError?: boolean;
}): FeatureArchiveAction | null {
  const {
    feature,
    emptyResponse,
    isCheckingEmpty,
    hasEmptyCheckError,
    relationPreview,
    isCheckingRelations = false,
    hasRelationCheckError = false,
  } = args;
  if (!feature) return null;
  if (feature.status === "archived") return "delete";
  if (isCheckingEmpty || isCheckingRelations) return null;
  if (hasEmptyCheckError || hasRelationCheckError) return "archive";
  return getFeatureArchiveAction(
    feature,
    emptyResponse?.empty ?? false,
    relationPreview?.has_relations ?? false,
  );
}

export function deleteFeatureDialogTitle(
  feature: Feature | undefined,
  t: UiTranslator = translateUi,
): string {
  return feature?.status === "archived"
    ? t("conversation.featureArchiveDecision.deleteArchivedSession", "Delete archived session?")
    : t("conversation.featureArchiveDecision.deleteSession", "Delete session?");
}

export async function resolveFeatureArchiveAction(
  feature: Feature,
  queryClient: QueryClient,
): Promise<FeatureArchiveAction> {
  if (feature.status === "archived") return "delete";
  const [preview, emptyResponse] = await Promise.all([
    queryClient.fetchQuery(
      getGetFeatureArchivePreviewQueryOptions(feature.id, {
        query: { retry: false, staleTime: 0 },
      }),
    ),
    queryClient.fetchQuery(
      getIsFeatureEmptyQueryOptions(feature.id, {
        query: { retry: false, staleTime: 0 },
      }),
    ),
  ]);
  return getFeatureArchiveAction(feature, emptyResponse.empty, preview.has_relations);
}
