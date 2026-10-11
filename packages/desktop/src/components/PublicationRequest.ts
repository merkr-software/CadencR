import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type PublicationReleasePreview,
  getListPublicationOperationsQueryKey,
} from "@/api/generated";

export function publicationBundles(preview: PublicationReleasePreview): {
  bundle_id: string;
  bundle_ids: string[];
} {
  return {
    bundle_id: preview.bundle_id,
    bundle_ids:
      preview.archives
        ?.map((archive) => archive.bundle_id)
        .filter((id) => id !== preview.bundle_id) ?? [],
  };
}

/** Refresh server-confirmed records at both mutation boundaries, including fast/lost responses. */
export function useRefreshPublicationJournal(projectId: number): () => void {
  const client = useQueryClient();
  const prefix = getListPublicationOperationsQueryKey(projectId)[0];
  return useCallback(() => {
    void client.invalidateQueries({
      predicate: ({ queryKey }) =>
        typeof queryKey[0] === "string" &&
        (queryKey[0] === prefix || queryKey[0].startsWith(`${prefix}/`)),
    });
  }, [client, prefix]);
}
