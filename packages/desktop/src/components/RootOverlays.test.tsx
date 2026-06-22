import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@/test-utils";
import { RootOverlays, type ConfirmFeatureAction } from "@/components/RootOverlays";
import type { Feature, FeatureWorktreeInfo } from "@/api/generated";

const features: Feature[] = [
  {
    id: 1,
    title: "Feature One",
    status: "active",
    type: "ws-session",
    project_id: 1,
    is_pinned: false,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 2,
    title: "Feature Two",
    status: "active",
    type: "ws-session",
    project_id: 1,
    is_pinned: false,
    created_at: "2026-01-02T00:00:00Z",
  },
];

const { mockListFeatureWorktrees } = vi.hoisted(() => ({
  mockListFeatureWorktrees: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useListFeatureWorktrees: mockListFeatureWorktrees,
  useDeleteWorktree: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useDeleteFeatureBranch: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useCheckBranchDelete: vi.fn(() => ({
    data: { branch: "feature/one", target_branch: "main", merged: true },
    isLoading: false,
  })),
  useGetGitStatus: vi.fn(() => ({ data: undefined, isLoading: false })),
  useKillTerminalSessions: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useListFeatureActivity: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/components/CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("@/components/KeyboardShortcutsModal", () => ({
  KeyboardShortcutsModal: () => null,
}));

vi.mock("@/components/UnifiedAgentsShortcut", () => ({
  UnifiedAgentsShortcut: () => null,
}));

vi.mock("@/components/PostUpdateChangelogDialog", () => ({
  PostUpdateChangelogDialog: () => null,
}));

vi.mock("@/components/theme/ThemeDrawer", () => ({
  ThemeDrawer: () => null,
}));

vi.mock("sonner", () => ({
  Toaster: () => null,
  toast: {
    promise: vi.fn((promise: Promise<unknown>) => promise),
  },
}));

function renderRootOverlays(confirmAction: ConfirmFeatureAction, onArchiveFeature = vi.fn()) {
  render(
    <RootOverlays
      commandPaletteOpen={false}
      setCommandPaletteOpen={vi.fn()}
      activeProjectId={1}
      activeFeatureId={2}
      confirmAction={confirmAction}
      setConfirmAction={vi.fn()}
      onArchiveFeature={onArchiveFeature}
      onDeleteFeature={vi.fn()}
      appClose={{
        showConfirm: false,
        setShowConfirm: vi.fn(),
        confirmAndClose: vi.fn(),
        runningAgents: [],
      }}
    />,
  );
  return onArchiveFeature;
}

describe("RootOverlays", () => {
  beforeEach(() => {
    mockListFeatureWorktrees.mockReturnValue({ data: [] });
  });

  it("confirms the feature id that opened the archive dialog, not the active route", async () => {
    const user = userEvent.setup();
    const onArchiveFeature = renderRootOverlays({ action: "archive", feature: features[0] });

    await user.click(screen.getByRole("button", { name: /archive/i }));

    expect(onArchiveFeature).toHaveBeenCalledWith(1);
  });

  it("hides worktree removal when archiving a feature attached to the main worktree", () => {
    mockListFeatureWorktrees.mockReturnValue({
      data: [
        {
          feature_id: 1,
          live: true,
          worktree_path: "/repo",
          worktree_branch: "main",
          is_default_branch: true,
          is_main_worktree: true,
        } satisfies FeatureWorktreeInfo,
      ],
    });

    renderRootOverlays({ action: "archive", feature: features[0] });

    expect(screen.queryByText("Remove worktree")).not.toBeInTheDocument();
    expect(screen.queryByText("Remove branch")).not.toBeInTheDocument();
  });

  it("hides worktree removal when archiving a feature without worktree metadata", () => {
    mockListFeatureWorktrees.mockReturnValue({ data: [] });

    renderRootOverlays({ action: "archive", feature: features[0] });

    expect(screen.queryByText("Remove worktree")).not.toBeInTheDocument();
    expect(screen.queryByText("Remove branch")).not.toBeInTheDocument();
  });
});
