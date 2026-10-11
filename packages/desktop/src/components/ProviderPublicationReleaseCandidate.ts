import { publicationBundles, useRefreshPublicationJournal } from "./PublicationRequest";
import { useCallback, useMemo, useState } from "react";
import {
  type PublicationReleasePreview,
  usePreviewPublicationRelease,
  usePublishPublicationRelease,
} from "@/api/generated";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function useReleaseCandidate(projectId: number, initialBundleId: string) {
  const [bundleId, setBundleId] = useState(initialBundleId);
  const [additionalBundles, setAdditionalBundles] = useState("");
  const bundleIds = useMemo(
    () => additionalBundles.split(/[\s,]+/).filter(Boolean),
    [additionalBundles],
  );
  const [releaseNotes, setReleaseNotes] = useState("");
  const [preview, setPreview] = useState<PublicationReleasePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [contributionPending, setContributionPending] = useState(false);
  const [registryPending, setRegistryPending] = useState(false);
  const previewMutation = usePreviewPublicationRelease({
    mutation: { onSuccess: setPreview },
  });
  const refreshJournal = useRefreshPublicationJournal(projectId);
  const publishMutation = usePublishPublicationRelease({
    mutation: {
      onSuccess: (result) => setPublishedUrl(result.release_url),
      onMutate: refreshJournal,
      onSettled: refreshJournal,
    },
  });
  const releasePending = previewMutation.isPending || publishMutation.isPending;
  const pending = releasePending || contributionPending || registryPending;
  const validInput = validCandidateInput(bundleId, bundleIds, releaseNotes);

  const { invalidatePreview, review, publish } = useReleaseActions({
    projectId,
    bundleId,
    bundleIds,
    releaseNotes,
    preview,
    confirmed,
    pending,
    validInput,
    previewMutation,
    publishMutation,
    setPreview,
    setConfirmed,
    setPublishedUrl,
  });
  const previewSnapshot = useMutationStatus(previewMutation);
  const publishSnapshot = useMutationStatus(publishMutation);

  return useMemo(
    () => ({
      bundleId,
      setBundleId,
      additionalBundles,
      setAdditionalBundles,
      releaseNotes,
      setReleaseNotes,
      preview,
      confirmed,
      setConfirmed,
      publishedUrl,
      contributionPending,
      setContributionPending,
      registryPending,
      setRegistryPending,
      previewMutation: previewSnapshot,
      publishMutation: publishSnapshot,
      pending,
      validInput,
      invalidatePreview,
      review,
      publish,
    }),
    [
      bundleId,
      setBundleId,
      additionalBundles,
      setAdditionalBundles,
      releaseNotes,
      setReleaseNotes,
      preview,
      confirmed,
      setConfirmed,
      publishedUrl,
      contributionPending,
      setContributionPending,
      registryPending,
      setRegistryPending,
      previewSnapshot,
      publishSnapshot,
      pending,
      validInput,
      invalidatePreview,
      review,
      publish,
    ],
  );
}
function useMutationStatus(value: { isPending: boolean; isError: boolean; error: unknown }) {
  return useMemo(
    () => ({ isPending: value.isPending, isError: value.isError, error: value.error }),
    [value.isPending, value.isError, value.error],
  );
}

function useReleaseActions({
  projectId,
  bundleId,
  bundleIds,
  releaseNotes,
  preview,
  confirmed,
  pending,
  validInput,
  previewMutation,
  publishMutation,
  setPreview,
  setConfirmed,
  setPublishedUrl,
}: {
  projectId: number;
  bundleId: string;
  bundleIds: string[];
  releaseNotes: string;
  preview: PublicationReleasePreview | null;
  confirmed: boolean;
  pending: boolean;
  validInput: boolean;
  previewMutation: ReturnType<typeof usePreviewPublicationRelease>;
  publishMutation: ReturnType<typeof usePublishPublicationRelease>;
  setPreview: (value: PublicationReleasePreview | null) => void;
  setConfirmed: (value: boolean) => void;
  setPublishedUrl: (value: string | null) => void;
}) {
  const previewReset = previewMutation.reset;
  const publishReset = publishMutation.reset;
  const previewMutate = previewMutation.mutate;
  const publishMutate = publishMutation.mutate;
  const invalidatePreview = useCallback((): void => {
    setPreview(null);
    setConfirmed(false);
    setPublishedUrl(null);
    previewReset();
    publishReset();
  }, [previewReset, publishReset]);

  const review = useCallback((): void => {
    if (!validInput || pending) return;
    invalidatePreview();
    previewMutate({
      id: projectId,
      data: { bundle_id: bundleId.trim(), bundle_ids: bundleIds, release_notes: releaseNotes },
    });
  }, [
    validInput,
    pending,
    invalidatePreview,
    previewMutate,
    projectId,
    bundleId,
    bundleIds,
    releaseNotes,
  ]);

  const publish = useCallback((): void => {
    if (!preview || !confirmed || pending) return;
    publishMutate({
      id: projectId,
      data: {
        ...publicationBundles(preview),
        release_notes: preview.release_notes,
        expected_plan_sha256: preview.plan_sha256,
        confirmed: true,
        operation_id: preview.operation_id,
      },
    });
  }, [preview, confirmed, pending, publishMutate, projectId]);
  return useMemo(
    () => ({ invalidatePreview, review, publish }),
    [invalidatePreview, review, publish],
  );
}

function validCandidateInput(bundleId: string, bundleIds: string[], releaseNotes: string): boolean {
  return (
    UUID_PATTERN.test(bundleId.trim()) &&
    bundleIds.every((id) => UUID_PATTERN.test(id)) &&
    releaseNotes.trim() !== ""
  );
}
