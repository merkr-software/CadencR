import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { composerKeyFor, useComposerContextStore } from "@/stores/composer-context-store";
import { ComposerContextProvider, type ComposerContextValue } from "./ComposerContext";
import { ReviewCommentsSuggestion } from "./ReviewCommentsSuggestion";

const mocks = vi.hoisted(() => ({
  pathPrefix: undefined as { prefix: string | null; root: string | null } | undefined,
}));

vi.mock("@/api/generated", () => ({
  useListDiffComments: () => ({
    data: [
      {
        id: 1,
        file_path: "packages/app/src/a.ts",
        line_number: 4,
        content: "inside",
        status: "pending",
      },
      { id: 2, file_path: "README.md", line_number: 1, content: "outside", status: "pending" },
    ],
  }),
  useGetGitPathPrefix: () => ({ data: mocks.pathPrefix, isError: false, error: null }),
}));

const FEATURE = 9;

function renderSuggestion() {
  const value = { featureId: FEATURE } as unknown as ComposerContextValue;
  return render(
    <ComposerContextProvider value={value}>
      <ReviewCommentsSuggestion />
    </ComposerContextProvider>,
  );
}

describe("ReviewCommentsSuggestion", () => {
  beforeEach(() => {
    localStorage.clear();
    useComposerContextStore.setState({ items: {} });
  });

  it("waits for the agent path mapping before offering the comments", () => {
    mocks.pathPrefix = undefined;
    renderSuggestion();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("attaches the comments under paths the agent resolves from its directory", async () => {
    mocks.pathPrefix = { prefix: "packages/app", root: "/repo" };
    const { user } = renderSuggestion();
    await user.click(screen.getByRole("button", { name: /2 review comments/i }));

    const [item] = useComposerContextStore.getState().items[composerKeyFor(FEATURE)] ?? [];
    expect(item?.content).toBe(
      "## src/a.ts\n- Line 4: inside\n## /repo/README.md\n- Line 1: outside",
    );
    // The stored comments keep their Git paths: only their ids travel along.
    expect(item?.commentIds).toEqual([1, 2]);
  });
});
