import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getFeature, getGetFeatureQueryKey, type Feature } from "@/api/generated";

/**
 * The project of a conversation, for the badge on its `@@` references.
 *
 * A conversation never changes project, so the answer lives under its own key,
 * outside `/api/features`: the invalidations every prompt, rename or pin sends
 * there would otherwise refetch it for each reference on screen. It starts from
 * the feature's detail when that is already cached, and a failed lookup (the
 * conversation was deleted) is not retried: the reference just shows no badge,
 * and opening it is what reports the error.
 */
export function featureProjectIdQueryOptions(queryClient: QueryClient, featureId: number) {
  return queryOptions({
    queryKey: ["conversation-project", featureId] as const,
    queryFn: ({ signal }) => getFeature(featureId, signal).then((feature) => feature.project_id),
    initialData: () =>
      queryClient.getQueryData<Feature>(getGetFeatureQueryKey(featureId))?.project_id,
    staleTime: Infinity,
    retry: false,
    retryOnMount: false,
  });
}

/** The project a conversation belongs to, or `null` until it is known. */
export function useFeatureProjectId(featureId: number): number | null {
  const queryClient = useQueryClient();
  const { data } = useQuery(featureProjectIdQueryOptions(queryClient, featureId));
  return data ?? null;
}
