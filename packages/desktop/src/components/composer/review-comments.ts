import { deleteDiffComment, getListDiffCommentsQueryKey } from "@/api/generated";
import { toastError } from "@/lib/api-errors";
import { queryClient } from "@/lib/queryClient";
import type { ComposerContextItem } from "@/stores/composer-context-store";

/**
 * Once a prompt carrying review comments was sent, take exactly those out of
 * the Git pane's pending batch. Until then they stay there, so removing the
 * chip or abandoning the draft never loses a review.
 */
export async function settleSentReviewComments(
  featureId: number | undefined,
  sent: ComposerContextItem[],
): Promise<void> {
  const ids = sent.flatMap((item) => item.commentIds ?? []);
  if (featureId == null || ids.length === 0) return;
  try {
    await Promise.all(ids.map((id) => deleteDiffComment(id)));
  } catch (error) {
    toastError(error, "Sent, but couldn't clear the review comments from the Git pane");
  } finally {
    void queryClient.invalidateQueries({ queryKey: getListDiffCommentsQueryKey(featureId) });
  }
}
