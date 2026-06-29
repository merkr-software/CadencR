import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen } from "@/test-utils";
import { ProjectFeatures } from "./ProjectFeatures";
import { resetMockIds } from "@/test-fixtures";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";

const mockNavigate = vi.fn();
const mockUpdateStatus = vi.fn();
const mockDelete = vi.fn();
const mockDisconnectSession = vi.fn();
const { mockUseIsFeatureEmpty } = vi.hoisted(() => ({
  mockUseIsFeatureEmpty: vi.fn(),
}));

interface MockUpdateStatusVariables {
  id: number;
  data: { status: "active" | "archived" };
}

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

const mockFeatures = [
  {
    id: 1,
    title: "Feature One",
    status: "active",
    type: "ws-session",
    project_id: 1,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 2,
    title: "Archived Session",
    status: "archived",
    type: "ws-session",
    project_id: 1,
    created_at: "2026-01-02T00:00:00Z",
  },
];

vi.mock("@/api/generated", () => ({
  FeatureStatus: { active: "active", archived: "archived" },
  useListFeatures: vi.fn(() => ({ data: mockFeatures })),
  useListFeatureActivity: vi.fn(() => ({ data: [], error: null })),
  useUpdateFeatureStatus: vi.fn(
    (opts?: {
      mutation?: { onSuccess?: (data: unknown, variables: MockUpdateStatusVariables) => void };
    }) => ({
      mutate: (data: MockUpdateStatusVariables) => {
        mockUpdateStatus(data);
        opts?.mutation?.onSuccess?.({}, data);
      },
    }),
  ),
  useUpdateFeaturePinned: vi.fn(() => ({ mutate: vi.fn() })),
  useDeleteFeature: vi.fn(
    (opts?: { mutation?: { onSuccess?: (data: unknown, variables: { id: number }) => void } }) => ({
      mutate: (data: { id: number }) => {
        mockDelete(data);
        opts?.mutation?.onSuccess?.({}, data);
      },
    }),
  ),
  useUpdateFeatureLabel: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteWorktree: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useDeleteFeatureBranch: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useKillTerminalSessions: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useCheckBranchDelete: vi.fn(() => ({
    data: { branch: "feature/a", target_branch: "main", merged: true },
    isLoading: false,
  })),
  useIsFeatureEmpty: mockUseIsFeatureEmpty,
  useGetGitStatus: vi.fn(() => ({ data: undefined, isLoading: false })),
  useListProjectWorktrees: vi.fn(() => ({ data: [] })),
  useListFeatureWorktrees: vi.fn(() => ({ data: [] })),
  useGetStats: vi.fn(() => ({ data: undefined })),
  getListFeaturesQueryKey: vi.fn((id: number) => ["features", "list", id]),
  getGetFeatureQueryKey: vi.fn((id: number) => ["features", "detail", id]),
  getGetFeatureSettingsQueryKey: vi.fn((id: number) => ["features", "settings", id]),
  getFeatureAgentState: vi.fn(() => Promise.resolve({ sessions: [] })),
  getGetFeatureAgentStateQueryKey: (id: number) => [`/api/features/${id}/agent-state`] as const,
  getBranch: vi.fn(() => Promise.resolve({ branch: "main" })),
  getGetBranchQueryKey: (params: unknown) => [`/api/git/branch`, params] as const,
  getStats: vi.fn(() => Promise.resolve({ insertions: 0, deletions: 0 })),
  getGetStatsQueryKey: (params: unknown) => [`/api/git/stats`, params] as const,
}));

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: Object.assign(
    vi.fn((selector: (s: { sessions: Record<string, unknown> }) => unknown) =>
      selector({ sessions: {} }),
    ),
    { getState: () => ({ disconnect: mockDisconnectSession }) },
  ),
}));

function renderProjectFeatures(activeFeatureId: number | null = null): void {
  render(
    <ProjectFeatures
      projectId={1}
      projectPath="/test/path"
      activeFeatureId={activeFeatureId}
      onSelectFeature={vi.fn()}
    />,
  );
}

function openFeatureContextMenu(featureTitle: string): void {
  const featureRow = screen.getByText(featureTitle).closest("[role=button]");
  expect(featureRow).not.toBeNull();
  fireEvent.contextMenu(featureRow as HTMLElement);
}

describe("ProjectFeatures archived section", () => {
  beforeEach(() => {
    resetMockIds();
    mockNavigate.mockClear();
    mockUpdateStatus.mockClear();
    mockDelete.mockClear();
    mockDisconnectSession.mockClear();
    mockUseIsFeatureEmpty.mockReturnValue({
      data: { empty: false },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    useFeatureLayoutStore.setState({ features: {} });
  });

  it("renders archived sessions collapsed behind the existing sidebar trigger", () => {
    renderProjectFeatures();

    const archivedButton = screen.getByRole("button", { name: /archived \(1\)/i });

    expect(screen.queryByText("Archived Session")).not.toBeInTheDocument();
    expect(archivedButton).toHaveClass("text-muted-foreground");
    expect(archivedButton).not.toHaveClass("bg-muted/60");
  });

  it("expands archived sessions when the archived section is clicked", async () => {
    const user = userEvent.setup();
    renderProjectFeatures();

    await user.click(screen.getByRole("button", { name: /archived \(1\)/i }));

    expect(screen.getByText("Archived Session")).toBeInTheDocument();
  });

  it("auto-expands the archived section for the active archived session", () => {
    renderProjectFeatures(2);

    expect(screen.getByText("Archived Session")).toBeInTheDocument();
  });

  it("shows only archive confirmation when archiving a feature without worktree metadata", async () => {
    const user = userEvent.setup();
    renderProjectFeatures();

    const featureRow = screen.getByText("Feature One").closest("[role=button]");
    expect(featureRow).not.toBeNull();
    fireEvent.contextMenu(featureRow as HTMLElement);
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));

    expect(screen.queryByText("Remove worktree")).not.toBeInTheDocument();
    expect(screen.queryByText("Remove branch")).not.toBeInTheDocument();
  });

  it("shows delete confirmation when archiving an active session with no agent messages", async () => {
    const user = userEvent.setup();
    mockUseIsFeatureEmpty.mockReturnValue({
      data: { empty: true },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    renderProjectFeatures();

    const featureRow = screen.getByText("Feature One").closest("[role=button]");
    expect(featureRow).not.toBeNull();
    fireEvent.contextMenu(featureRow as HTMLElement);
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));

    expect(screen.getByText("Delete session?")).toBeInTheDocument();
    expect(screen.queryByText("Archive session?")).not.toBeInTheDocument();
  });

  it("leaves the active chat route after archiving the current session", async () => {
    const user = userEvent.setup();
    renderProjectFeatures(1);

    openFeatureContextMenu("Feature One");
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: /archive/i }));

    expect(mockUpdateStatus).toHaveBeenCalledWith({
      id: 1,
      data: { status: "archived" },
    });
    expect(mockDisconnectSession).toHaveBeenCalledWith("ws-feature-1");
    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/",
    });
  });

  it("shows unarchive and delete actions for archived session context menus", async () => {
    renderProjectFeatures(2);

    openFeatureContextMenu("Archived Session");

    expect(await screen.findByRole("menuitem", { name: "Unarchive" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("restores an archived session to active status from the context menu", async () => {
    const user = userEvent.setup();
    renderProjectFeatures(2);

    openFeatureContextMenu("Archived Session");
    await user.click(await screen.findByRole("menuitem", { name: "Unarchive" }));

    expect(mockUpdateStatus).toHaveBeenCalledWith({
      id: 2,
      data: { status: "active" },
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
