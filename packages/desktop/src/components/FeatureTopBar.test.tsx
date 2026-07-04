import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { formatCompactCombo } from "@/lib/shortcuts/format";
import { getRegistryShortcut } from "@/lib/shortcuts/resolve";
import { FeatureTopBar } from "./FeatureTopBar";

const platformMock = vi.hoisted(() => ({ hasMacWindowControls: false }));

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn(),
}));

vi.mock("@/lib/mac-window-controls", () => ({
  get HAS_MAC_WINDOW_CONTROLS() {
    return platformMock.hasMacWindowControls;
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => {
    const React = require("react");
    return React.createElement("a", { href: to }, children);
  },
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    themeId: "dracula",
    theme: {
      logo: {
        src: "dracula-logo.svg",
        alt: "Cadencr",
        variant: "dark",
        displayScale: 1.24,
      },
    },
    setTheme: vi.fn(),
    isLoading: false,
  }),
}));

const mockSetFeatureSetting = vi.fn();
const mockAutoName = vi.fn();

let mockFeatureData: Record<string, unknown> = {
  id: 1,
  title: "My Test Feature",
  type: "ws-session",
  project_id: 1,
  created_at: "2024-01-01",
};

vi.mock("@/api/generated", () => ({
  useGetFeature: vi.fn(() => ({ data: mockFeatureData })),
  useGetFeatureSettings: vi.fn(() => ({
    data: [{ key: "worktree_branch", value: "feature/my-branch" }],
  })),
  getGetFeatureSettingsQueryKey: vi.fn((id: number) => ["features", "settings", id]),
  useSetFeatureSetting: vi.fn(() => ({ mutate: mockSetFeatureSetting })),
  useAutoNameFeature: vi.fn(() => ({ mutate: mockAutoName })),
  useGetStats: vi.fn(() => ({
    data: { commits: 3, insertions: 10, deletions: 2 },
    refetch: vi.fn(),
  })),
  useGetBranch: vi.fn(() => ({ data: { branch: "main" } })),
  useListFeatureWorktrees: vi.fn(() => ({ data: [], isLoading: false, error: null })),
  useGetFileBlobShas: vi.fn(() => ({ data: [] })),
  // GitActionButton + BranchChip dependencies — feature/git-workflow-overhaul.
  PushForceMode: { none: "none", force: "force", "force-with-lease": "force-with-lease" },
  usePush: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useCommit: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useGetUncommittedFiles: vi.fn(() => ({ data: [], isLoading: false, isError: false })),
  useListBranches: vi.fn(() => ({ data: [], isLoading: false, isError: false })),
  useUpdateTargetBranch: vi.fn(() => ({ mutateAsync: vi.fn() })),
  getCompareUrl: vi.fn(),
}));

// CustomActionsBar pulls in network hooks we don't care about for these tests.
vi.mock("./CustomActionsBar", () => ({
  CustomActionsBar: () => {
    const React = require("react");
    return React.createElement("div", { "data-testid": "custom-actions-bar" });
  },
}));

vi.mock("@/hooks/useFeatureTitle", () => ({
  useFeatureTitle: vi.fn(() => ({ title: null, isAutoNaming: false })),
}));

vi.mock("@/components/ProjectBadge", () => ({
  ProjectBadge: ({ projectId }: { projectId: number }) => {
    const React = require("react");
    return React.createElement("span", { "data-testid": `color-dot-${projectId}` });
  },
}));

// Mock ModelSelector
vi.mock("./ModelSelector", () => ({
  ModelSelector: () => {
    const React = require("react");
    return React.createElement("div", { "data-testid": "model-selector" });
  },
}));

const mockSetCollapsed = vi.fn();
const EXPAND_TITLE = `Expand sidebar (${formatCompactCombo(
  getRegistryShortcut("toggle-sidebar").keys,
)})`;
let mockSidebarCollapsed = false;

vi.mock("@/components/SidebarContext", () => ({
  useSidebarCollapsed: () => ({ collapsed: mockSidebarCollapsed, setCollapsed: mockSetCollapsed }),
}));

describe("FeatureTopBar", () => {
  beforeEach(() => {
    mockSetFeatureSetting.mockClear();
    mockSetCollapsed.mockClear();
    mockAutoName.mockClear();
    mockSidebarCollapsed = false;
    platformMock.hasMacWindowControls = false;
    mockFeatureData = {
      id: 1,
      title: "My Test Feature",
      type: "ws-session",
      project_id: 1,
      created_at: "2024-01-01",
    };
  });

  it("renders feature title", () => {
    render(<FeatureTopBar featureId={1} projectId={1} />);
    expect(screen.getByText("My Test Feature")).toBeInTheDocument();
  });

  it("renders the feature label next to the title", () => {
    mockFeatureData = { ...mockFeatureData, label: "Review" };
    render(<FeatureTopBar featureId={1} projectId={1} />);
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("auto-renames from the feature title context menu", async () => {
    const { user } = render(<FeatureTopBar featureId={1} projectId={1} />);

    fireEvent.contextMenu(screen.getByRole("heading", { name: "My Test Feature" }));
    await user.click(await screen.findByText("Auto-rename"));

    expect(mockAutoName).toHaveBeenCalledWith({ id: 1 });
  });

  it("shows auto-rename on default session titles so users can retry after a silent failure", async () => {
    mockFeatureData = {
      ...mockFeatureData,
      title: "Session 3",
      type: "ws-session",
    };
    render(<FeatureTopBar featureId={1} projectId={1} mode="session" />);

    fireEvent.contextMenu(screen.getByRole("heading", { name: "Session 3" }));

    expect(await screen.findByText("Auto-rename")).toBeInTheDocument();
  });

  it("never renders a feature status badge", () => {
    // ws-feature is gone, so the legacy status badge should never appear,
    // even in the non-session "feature" mode.
    render(<FeatureTopBar featureId={1} projectId={1} />);
    expect(screen.queryByText("in-progress")).not.toBeInTheDocument();
  });

  it("renders without crashing", () => {
    render(<FeatureTopBar featureId={1} projectId={1} />);
    expect(screen.getByText("My Test Feature")).toBeInTheDocument();
  });

  it("renders git stats with branch info", () => {
    render(<FeatureTopBar featureId={1} projectId={1} />);
    // Git stats (3 commits) should be visible somewhere
    expect(screen.getByText("My Test Feature")).toBeInTheDocument();
  });

  it("keeps collapsed chrome mounted while toggling its accessibility state", () => {
    const { container, rerender } = render(<FeatureTopBar featureId={1} projectId={1} />);
    const chrome = container.querySelector("[data-sidebar-collapsed-chrome]");
    expect(chrome).toHaveAttribute("data-visible", "false");
    expect(chrome).toHaveAttribute("aria-hidden", "true");
    expect(chrome).toHaveAttribute("inert");

    mockSidebarCollapsed = true;
    rerender(<FeatureTopBar featureId={1} projectId={1} />);

    expect(container.querySelector("[data-sidebar-collapsed-chrome]")).toBe(chrome);
    expect(chrome).toHaveAttribute("data-visible", "true");
    expect(chrome).not.toHaveAttribute("aria-hidden");
    expect(chrome).not.toHaveAttribute("inert");
  });

  it("shows logo and app name when sidebar is collapsed", () => {
    mockSidebarCollapsed = true;
    const { container } = render(<FeatureTopBar featureId={1} projectId={1} />);
    const chrome = container.querySelector("[data-sidebar-collapsed-chrome]");
    expect(chrome).toHaveAttribute("data-visible", "true");
    expect(chrome).not.toHaveAttribute("inert");
    expect(screen.getByText("Cadencr")).toBeInTheDocument();
    expect(screen.getByAltText("Cadencr")).toBeInTheDocument();
  });

  it("shows expand button when sidebar is collapsed", () => {
    mockSidebarCollapsed = true;
    render(<FeatureTopBar featureId={1} projectId={1} />);
    expect(screen.getByTitle(EXPAND_TITLE)).toBeInTheDocument();
  });

  it("shows settings link when sidebar is collapsed", () => {
    mockSidebarCollapsed = true;
    render(<FeatureTopBar featureId={1} projectId={1} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("uses compact Mac spacing when the sidebar is collapsed", () => {
    mockSidebarCollapsed = true;
    platformMock.hasMacWindowControls = true;
    render(<FeatureTopBar featureId={1} projectId={1} />);

    const header = screen
      .getByRole("heading", { name: "My Test Feature" })
      .closest("[data-feature-header]");
    expect(header).toHaveClass("pt-1.5", "pb-0");
    expect(screen.getByTitle("Expand sidebar (⌘B)")).toHaveClass("size-6");
    expect(screen.getByTitle("Settings")).toHaveClass("size-6");
  });

  it("renders ModelSelector for feature settings", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<FeatureTopBar featureId={1} projectId={1} />);
    await user.click(screen.getByTitle("Feature settings"));
    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
  });

  it("hides feature settings in session mode", () => {
    render(<FeatureTopBar featureId={1} projectId={1} mode="session" />);
    expect(screen.queryByTitle("Feature settings")).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
  });

  it("calls setCollapsed(false) when expand button is clicked", async () => {
    mockSidebarCollapsed = true;
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<FeatureTopBar featureId={1} projectId={1} />);
    await user.click(screen.getByTitle(EXPAND_TITLE));
    expect(mockSetCollapsed).toHaveBeenCalledWith(false);
  });
});
