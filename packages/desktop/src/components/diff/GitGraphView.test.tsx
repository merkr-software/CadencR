// This suite must exercise the REAL react-virtuoso: the global test-setup
// replaces Virtuoso with a safe flat-render shim, which cannot reproduce the
// production crash (issue #88). The real library stores the `components` prop
// in internal state and later reads `components.EmptyPlaceholder`; passing
// `components={undefined}` overwrites its default `{}` and throws.
import { beforeEach, describe, it, expect, vi } from "vitest";

vi.unmock("react-virtuoso");

import { act, fireEvent, render, screen } from "@/test-utils";
import { GitGraphView } from "./GitGraphView";
import type { CommitGraphResponse } from "@/api/generated";
import type { GitNavigationAdapter } from "./gitNavigation";
import { useGitStatusStore } from "@/stores/useGitStatusStore";

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
  decorations: [{ name: "feature/x", kind: "head" as const }],
  files_changed: 1,
  additions: 2,
  deletions: 0,
};

function mockGraph(hasMore: boolean, commits = [commit]): void {
  const data: CommitGraphResponse = {
    commits,
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
  beforeEach(() => {
    vi.clearAllMocks();
    useGitStatusStore.setState({ byFeature: {} });
  });

  it("states how many commits are still only local, and when everything is pushed", () => {
    mockGraph(false);
    const status = {
      feature_id: 1,
      current_branch: "feature/x",
      target_branch: "main",
      uncommitted_count: 0,
      staged_count: 0,
      unstaged_count: 0,
      untracked_count: 0,
      ahead_of_remote: 3,
      behind_remote: 0,
      ahead_of_target: 3,
      has_remote: true,
      computed_at: 1,
    };
    useGitStatusStore.getState().setStatus(status);
    render(<GitGraphView featureId={1} />);
    expect(screen.getByText("3 not pushed")).toBeInTheDocument();

    act(() =>
      useGitStatusStore.getState().setStatus({ ...status, ahead_of_remote: 0, computed_at: 2 }),
    );
    expect(screen.queryByText("3 not pushed")).not.toBeInTheDocument();
    expect(screen.getByText("All pushed")).toBeInTheDocument();
  });

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

  it("requests and labels a dedicated branch graph with a path back", () => {
    mockGraph(false);
    // The checked-out branch's counts would describe another branch here.
    useGitStatusStore.getState().setStatus({
      feature_id: 1,
      current_branch: "feature/x",
      target_branch: "main",
      uncommitted_count: 0,
      staged_count: 0,
      unstaged_count: 0,
      untracked_count: 0,
      ahead_of_remote: 3,
      behind_remote: 0,
      ahead_of_target: 3,
      has_remote: true,
      computed_at: 1,
    });
    const onBack = vi.fn();
    render(
      <GitGraphView
        featureId={1}
        branch={{ name: "origin/release", is_local: false }}
        onBackToBranches={onBack}
      />,
    );

    expect(useGetCommitGraph).toHaveBeenCalledWith(
      {
        feature_id: 1,
        branch: "origin/release",
        branch_is_local: false,
        skip: 0,
        limit: 50,
      },
      { query: { placeholderData: expect.any(Function) } },
    );
    expect(screen.getByText("origin/release")).toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.queryByText("3 not pushed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("navigates and opens commits through the Git adapter", () => {
    const secondCommit = {
      ...commit,
      sha: "def456abc123",
      short_sha: "def456a",
      message: "Second change",
    };
    mockGraph(false, [commit, secondCommit]);
    const capture: { current: GitNavigationAdapter | null } = { current: null };
    render(
      <GitGraphView
        featureId={1}
        registerNavigationAdapter={(next) => {
          capture.current = next;
          return () => {};
        }}
      />,
    );

    expect(capture.current?.getActiveItem()).toBe(commit.sha);
    act(() => expect(capture.current?.moveSelection(1)).toBe(true));
    expect(capture.current?.getActiveItem()).toBe(secondCommit.sha);
    act(() => expect(capture.current?.open()).toBe(true));
    expect(screen.getByRole("button", { name: "Commits" })).toBeInTheDocument();
    act(() => expect(capture.current?.back()).toBe(true));
    expect(screen.queryByRole("button", { name: "Commits" })).not.toBeInTheDocument();
  });
});
