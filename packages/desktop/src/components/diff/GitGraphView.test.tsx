// This suite must exercise the REAL react-virtuoso: the global test-setup
// replaces Virtuoso with a safe flat-render shim, which cannot reproduce the
// production crash (issue #88). The real library stores the `components` prop
// in internal state and later reads `components.EmptyPlaceholder`; passing
// `components={undefined}` overwrites its default `{}` and throws.
import { describe, it, expect, vi } from "vitest";

vi.unmock("react-virtuoso");

import { render, screen } from "@/test-utils";
import { GitGraphView } from "./GitGraphView";
import type { CommitGraphResponse } from "@/api/generated";

const commit = {
  sha: "abc123def456",
  short_sha: "abc123d",
  message: "Fix the thing",
  body: "",
  author: "rle",
  date: "2026-01-01 12:00:00 +0000",
  is_pushed: true,
  parents: [],
  refs: ["feature/x"],
  files_changed: 1,
  additions: 2,
  deletions: 0,
};

function mockGraph(hasMore: boolean): void {
  const data: CommitGraphResponse = {
    commits: [commit],
    has_more: hasMore,
    current_branch: "feature/x",
    target_branch: "main",
  };
  vi.mocked(useGetCommitGraph).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useGetCommitGraph>);
}

vi.mock("@/api/generated", () => ({
  useGetCommitGraph: vi.fn(),
  getCommitUrl: vi.fn(),
}));

vi.mock("@/lib/desktop-bridge", () => ({
  desktopBridge: { openExternal: vi.fn() },
}));

vi.mock("./DiffViewer", () => ({
  DiffViewer: () => null,
}));

import { useGetCommitGraph } from "@/api/generated";

describe("GitGraphView", () => {
  it("renders the commit graph when there are no more pages (has_more: false)", () => {
    mockGraph(false);
    // Without the fix this throws:
    //   Cannot read properties of undefined (reading 'EmptyPlaceholder')
    expect(() => render(<GitGraphView featureId={1} />)).not.toThrow();
    // Header renders outside Virtuoso — confirms we mounted through to the list.
    expect(screen.getByText("feature/x")).toBeInTheDocument();
  });

  it("renders the commit graph when more pages are available (has_more: true)", () => {
    mockGraph(true);
    expect(() => render(<GitGraphView featureId={1} />)).not.toThrow();
  });
});
