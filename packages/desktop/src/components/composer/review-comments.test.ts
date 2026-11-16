import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteDiffComment = vi.fn();
const toastError = vi.fn();
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  deleteDiffComment: (id: number) => deleteDiffComment(id),
}));
vi.mock("@/lib/api-errors", () => ({ toastError: (...args: unknown[]) => toastError(...args) }));

import { settleSentReviewComments } from "./review-comments";
import type { ComposerContextItem } from "@/stores/composer-context-store";

const review = (commentIds: number[]): ComposerContextItem => ({
  id: "r",
  kind: "review",
  label: "Review comments",
  content: "…",
  commentIds,
});

describe("settleSentReviewComments", () => {
  beforeEach(() => {
    deleteDiffComment.mockReset().mockResolvedValue({});
    toastError.mockReset();
  });

  it("removes exactly the comments the sent prompt carried", async () => {
    await settleSentReviewComments(4, [
      review([1, 2]),
      { id: "p", kind: "pasted", label: "P", content: "x" },
    ]);
    expect(deleteDiffComment.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  });

  it("does nothing when no review was sent", async () => {
    await settleSentReviewComments(4, [{ id: "p", kind: "pasted", label: "P", content: "x" }]);
    expect(deleteDiffComment).not.toHaveBeenCalled();
  });

  it("says so when the comments could not be cleared", async () => {
    deleteDiffComment.mockRejectedValue(new Error("gone"));
    await settleSentReviewComments(4, [review([1])]);
    expect(toastError).toHaveBeenCalledOnce();
  });
});
