import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  useGetFeatureArchivePreview,
  useIsFeatureEmpty,
  type Feature,
  type FeatureWorktreeInfo,
} from "@/api/generated";
import { getArchiveCleanupAvailability } from "@/components/archive-cleanup-availability";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  getPendingFeatureArchiveAction,
  type FeatureArchiveAction,
} from "@/lib/feature-archive-decision";

interface LatchedDecision {
  featureId: number;
  action: FeatureArchiveAction;
}

export function useFeatureArchiveConfirmation(
  confirmFeatureId: number | null,
  features: readonly Feature[],
  worktreeByFeatureId: ReadonlyMap<number, FeatureWorktreeInfo>,
) {
  const [latched, setLatched] = useState<LatchedDecision | null>(null);
  const feature = features.find((candidate) => candidate.id === confirmFeatureId);
  const isDelete = feature?.status === "archived";
  const emptyCheck = useIsFeatureEmpty(confirmFeatureId ?? 0, {
    query: { enabled: confirmFeatureId != null && !isDelete, retry: false, staleTime: 0 },
  });
  const relationCheck = useGetFeatureArchivePreview(confirmFeatureId ?? 0, {
    query: { enabled: confirmFeatureId != null && !isDelete, retry: false, staleTime: 0 },
  });
  const pendingAction = getPendingFeatureArchiveAction({
    feature,
    emptyResponse: emptyCheck.data,
    isCheckingEmpty: emptyCheck.isLoading || emptyCheck.isFetching,
    hasEmptyCheckError: emptyCheck.error != null,
    relationPreview: relationCheck.data,
    isCheckingRelations: relationCheck.isLoading || relationCheck.isFetching,
    hasRelationCheckError: relationCheck.error != null,
  });
  useEffect(() => {
    if (confirmFeatureId == null) {
      setLatched(null);
    } else if (pendingAction != null && latched?.featureId !== confirmFeatureId) {
      setLatched({ featureId: confirmFeatureId, action: pendingAction });
    }
  }, [confirmFeatureId, latched?.featureId, pendingAction]);
  const isChecking =
    !isDelete &&
    confirmFeatureId != null &&
    latched?.featureId !== confirmFeatureId &&
    pendingAction == null;
  useEffect(() => {
    if (confirmFeatureId == null) return;
    const toastId = `feature-archive-check-${confirmFeatureId}`;
    if (isChecking) toast.loading("Checking conversation…", { id: toastId });
    else toast.dismiss(toastId);
    return () => {
      toast.dismiss(toastId);
    };
  }, [confirmFeatureId, isChecking]);
  useEffect(() => {
    if (emptyCheck.error == null || confirmFeatureId == null || isDelete) return;
    toast.error(apiErrorMessage(emptyCheck.error, "Failed to check whether session is empty"));
  }, [confirmFeatureId, emptyCheck.error, isDelete]);
  useEffect(() => {
    if (relationCheck.error == null || confirmFeatureId == null || isDelete) return;
    toast.error(apiErrorMessage(relationCheck.error, "Failed to load related conversations"));
  }, [confirmFeatureId, isDelete, relationCheck.error]);
  return useMemo(
    () => ({
      action: latched?.featureId === confirmFeatureId ? latched.action : null,
      cleanup: getArchiveCleanupAvailability(feature ? worktreeByFeatureId.get(feature.id) : null),
      feature,
    }),
    [confirmFeatureId, feature, latched, worktreeByFeatureId],
  );
}
