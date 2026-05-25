import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { ProjectFeatures } from "./ProjectFeatures";
import { shouldIgnoreFeatureRowKeyDown } from "./ProjectFeatureRow";
import { resetMockIds } from "@/test-fixtures";
import { ROOT_LEAF_ID } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";

type UserEvent = ReturnType<typeof userEvent.setup>;

async function openLabelEditor(user: UserEvent, featureText: string): Promise<void> {
  const row = screen.getByText(featureText).closest("[role=button]");
  if (!row) throw new Error(`Feature row not found for "${featureText}"`);
  fireEvent.contextMenu(row);
  await user.click(await screen.findByText("Set label"));
  await screen.findByText("Set feature label");
}

const mockNavigate = vi.fn();
const _mockInvalidate = vi.fn();
const mockUpdateLabel = vi.fn();
const mockUpdateStatus = vi.fn();
const mockDelete = vi.fn();
const mockDeleteWorktree = vi.fn();
const mockDeleteBranch = vi.fn();
interface MockFeatureWorktreeInfo {
  feature_id: number;
  worktree_path: string;
  worktree_branch: string | null;
  live: boolean;
}

const { mockListFeatureWorktrees, mockGetGitStatus } = vi.hoisted(() => ({
  mockListFeatureWorktrees: vi.fn<() => { data: MockFeatureWorktreeInfo[] }>(() => ({
    data: [],
  })),
  mockGetGitStatus: vi.fn(() => ({ data: undefined, isLoading: false })),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

const mockFeatures = [
  {
    id: 1,
    title: "Feature One",
    status: "active",
    label: "Review",
    type: "ws-session",
    project_id: 1,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 2,
    title: "Feature Two",
    status: "active",
    label: "Blocked",
    type: "ws-session",
    project_id: 1,
    created_at: "2026-01-02T00:00:00Z",
  },
  {
    id: 3,
    title: "Session One",
    status: "active",
    type: "ws-session",
    project_id: 1,
    created_at: "2026-01-03T00:00:00Z",
  },
  {
    id: 4,
    title: "Archived Session",
    status: "archived",
    type: "ws-session",
    project_id: 1,
    created_at: "2026-01-04T00:00:00Z",
  },
];

vi.mock("@/api/generated", () => ({
  FeatureStatus: { active: "active", archived: "archived" },
  useListFeatures: vi.fn(() => ({ data: mockFeatures })),
  useUpdateFeatureLabel: vi.fn(
    (opts?: { onSuccess?: (data: unknown, variables: unknown) => void }) => ({
      mutate: (data: unknown) => {
        mockUpdateLabel(data);
        opts?.onSuccess?.({}, data);
      },
      isPending: false,
    }),
  ),
  useUpdateFeatureStatus: vi.fn((opts?: { mutation?: { onSuccess?: () => void } }) => ({
    mutate: (data: unknown) => {
      mockUpdateStatus(data);
      opts?.mutation?.onSuccess?.();
    },
  })),
  useDeleteFeature: vi.fn(
    (opts?: { mutation?: { onSuccess?: (data: unknown, variables: unknown) => void } }) => ({
      mutate: (data: unknown) => {
        mockDelete(data);
        opts?.mutation?.onSuccess?.({}, data);
      },
    }),
  ),
  useDeleteWorktree: vi.fn(() => ({ mutateAsync: mockDeleteWorktree })),
  useDeleteFeatureBranch: vi.fn(() => ({ mutateAsync: mockDeleteBranch })),
  useCheckBranchDelete: vi.fn(() => ({
    data: { branch: "feature/a", target_branch: "main", merged: true },
  })),
  useGetGitStatus: mockGetGitStatus,
  getListFeaturesQueryKey: vi.fn((id: number) => ["features", "list", id]),
  getGetFeatureQueryKey: vi.fn((id: number) => ["features", "detail", id]),
  getGetFeatureSettingsQueryKey: vi.fn((id: number) => ["features", "settings", id]),
  useListProjectWorktrees: vi.fn(() => ({ data: [] })),
  useListFeatureWorktrees: mockListFeatureWorktrees,
  useGetStats: vi.fn(() => ({ data: undefined })),
  getFeatureAgentState: vi.fn(() => Promise.resolve({ sessions: [] })),
  getGetFeatureAgentStateQueryKey: (id: number) => [`/api/features/${id}/agent-state`] as const,
  getBranch: vi.fn(() => Promise.resolve({ branch: "main" })),
  getGetBranchQueryKey: (params: unknown) => [`/api/git/branch`, params] as const,
  getStats: vi.fn(() => Promise.resolve({ insertions: 0, deletions: 0 })),
  getGetStatsQueryKey: (params: unknown) => [`/api/git/stats`, params] as const,
}));

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: vi.fn((selector: (s: { sessions: Record<string, unknown> }) => unknown) =>
    selector({ sessions: {} }),
  ),
}));

describe("ProjectFeatures", () => {
  beforeEach(() => {
    resetMockIds();
    mockNavigate.mockClear();
    mockUpdateLabel.mockClear();
    mockUpdateStatus.mockClear();
    mockDelete.mockClear();
    mockDeleteWorktree.mockClear();
    mockDeleteBranch.mockClear();
    mockListFeatureWorktrees.mockReturnValue({ data: [] });
    mockGetGitStatus.mockReturnValue({ data: undefined, isLoading: false });
    useFeatureLayoutStore.setState({ features: {} });
  });

  it("renders feature list", () => {
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );
    expect(screen.getByText("Feature One")).toBeInTheDocument();
    expect(screen.getByText("Feature Two")).toBeInTheDocument();
    expect(screen.getByText("Session One")).toBeInTheDocument();
    expect(screen.queryByText("Archived Session")).not.toBeInTheDocument();
  });

  it("highlights active feature", () => {
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={1}
        onSelectFeature={vi.fn()}
      />,
    );
    // Feature One should have active styling
    const featureEl = screen.getByText("Feature One").closest("[role=button]");
    expect(featureEl).toHaveClass("bg-accent");
  });

  it("navigates to feature on click", async () => {
    const user = userEvent.setup();
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );
    await user.click(screen.getByText("Feature One"));
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/ws-session/$sessionId",
      }),
    );
  });

  it("passes the currently focused tab when navigating to another feature", async () => {
    const user = userEvent.setup();
    useFeatureLayoutStore.getState().setState(1, {
      version: 1,
      splitRoot: {
        type: "leaf",
        id: ROOT_LEAF_ID,
        tabIds: ["agent", "terminal", "git", "editor"],
        activeTabId: "terminal",
      },
      focusedPaneId: ROOT_LEAF_ID,
      appliedLayoutId: null,
    });
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={1}
        onSelectFeature={vi.fn()}
      />,
    );

    await user.click(screen.getByText("Feature Two"));

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ focusTab: "terminal" }),
      }),
    );
  });

  it("calls onSelectFeature when feature clicked", async () => {
    const user = userEvent.setup();
    const onSelectFeature = vi.fn();
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={onSelectFeature}
      />,
    );
    await user.click(screen.getByText("Feature One"));
    expect(onSelectFeature).toHaveBeenCalledWith(1);
  });

  it("does not render auto-rename controls in the sidebar", () => {
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Auto-rename" })).not.toBeInTheDocument();
  });

  it("renders status badges for features", () => {
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );
    // Features with different statuses render without crashing
    expect(screen.getByText("Feature Two")).toBeInTheDocument();
  });

  it("renders feature labels in the sidebar metadata line", () => {
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );

    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("opens the label editor popover from the context menu and saves with Enter", async () => {
    const user = userEvent.setup();
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );

    await openLabelEditor(user, "Feature One");
    const input = screen.getByDisplayValue("Review");
    await user.clear(input);
    await user.type(input, "QA{Enter}");

    expect(mockUpdateLabel).toHaveBeenCalledWith({ id: 1, data: { label: "QA" } });
  });

  it("opens the active feature label editor with Cmd+Shift+L", () => {
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={1}
        onSelectFeature={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { code: "KeyL", key: "L", metaKey: true, shiftKey: true });

    expect(screen.getByText("Set feature label")).toBeInTheDocument();
  });

  it("does not save when the label is unchanged", async () => {
    const user = userEvent.setup();
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );

    await openLabelEditor(user, "Feature One");
    await user.keyboard("{Enter}");

    expect(mockUpdateLabel).not.toHaveBeenCalled();
  });

  it("opens the label editor popover from the context menu", async () => {
    const user = userEvent.setup();
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={1}
        onSelectFeature={vi.fn()}
      />,
    );

    const featureRow = screen.getByText("Feature One").closest("[role=button]");
    expect(featureRow).not.toBeNull();
    fireEvent.contextMenu(featureRow as HTMLElement);
    await user.click(await screen.findByText("Set label"));

    expect(screen.getByText("Set feature label")).toBeInTheDocument();
  });

  it("does not navigate when typing spaces in the label editor", async () => {
    const user = userEvent.setup();
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );

    await openLabelEditor(user, "Feature One");
    const callsBeforeTyping = mockNavigate.mock.calls.length;
    const input = screen.getByDisplayValue("Review");
    await user.clear(input);
    await user.type(input, "In progress");

    expect(mockNavigate).toHaveBeenCalledTimes(callsBeforeTyping);
  });

  it("groups active features that share a non-main worktree (>= 2 features)", () => {
    mockListFeatureWorktrees.mockReturnValue({
      data: [
        // Two features share the same non-main worktree -> should group.
        {
          feature_id: 1,
          worktree_path: "/test/wt/shared",
          worktree_branch: "feature/shared",
          live: true,
        },
        {
          feature_id: 2,
          worktree_path: "/test/wt/shared",
          worktree_branch: "feature/shared",
          live: true,
        },
        // Singleton non-main worktree -> stays flat, no header.
        {
          feature_id: 3,
          worktree_path: "/test/wt/solo",
          worktree_branch: "feature/solo",
          live: true,
        },
      ],
    });
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );
    expect(screen.getByText("feature/shared")).toBeInTheDocument();
    expect(screen.getByText("(2)")).toBeInTheDocument();
    // Singleton worktree branch is NOT used as a group header.
    expect(screen.queryByText("feature/solo")).not.toBeInTheDocument();
  });

  it("does not group features in the main worktree", () => {
    mockListFeatureWorktrees.mockReturnValue({
      data: [
        // Both features point at the project path (main worktree) -> no group.
        { feature_id: 1, worktree_path: "/test/path", worktree_branch: "main", live: true },
        { feature_id: 2, worktree_path: "/test/path", worktree_branch: "main", live: true },
      ],
    });
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.queryByText("(2)")).not.toBeInTheDocument();
  });

  it("falls back to the worktree path basename when branch is missing", () => {
    mockListFeatureWorktrees.mockReturnValue({
      data: [
        {
          feature_id: 1,
          worktree_path: "/test/wt/my-branch-dir",
          worktree_branch: null,
          live: true,
        },
        {
          feature_id: 2,
          worktree_path: "/test/wt/my-branch-dir",
          worktree_branch: null,
          live: true,
        },
      ],
    });
    render(
      <ProjectFeatures
        projectId={1}
        projectPath="/test/path"
        activeFeatureId={null}
        onSelectFeature={vi.fn()}
      />,
    );
    expect(screen.getByText("my-branch-dir")).toBeInTheDocument();
  });

  it("ignores row keyboard navigation from interactive descendants", () => {
    const input = document.createElement("input");
    const textbox = document.createElement("div");
    const plainRowTarget = document.createElement("div");
    textbox.setAttribute("role", "textbox");

    expect(shouldIgnoreFeatureRowKeyDown(input)).toBe(true);
    expect(shouldIgnoreFeatureRowKeyDown(textbox)).toBe(true);
    expect(shouldIgnoreFeatureRowKeyDown(plainRowTarget)).toBe(false);
  });
});
