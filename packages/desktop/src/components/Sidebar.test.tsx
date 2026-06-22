import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { Sidebar } from "./Sidebar";

const mockNavigate = vi.fn();

let mockLocation: { pathname: string; search?: Record<string, unknown> } = {
  pathname: "/",
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useRouterState: () => ({
    location: mockLocation,
  }),
  Link: ({ children, to }: { children: unknown; to: string }) => {
    const React = require("react");
    return React.createElement("a", { href: to }, children);
  },
}));

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn(),
}));

let mockLogoSrc = "dracula-logo.svg";

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    themeId: "dracula",
    theme: {
      logo: {
        src: mockLogoSrc,
        alt: "Cadencr",
        variant: "dark",
        displayScale: 1.24,
      },
    },
    setTheme: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("../api/generated", () => ({
  useListProjects: vi.fn(() => ({
    data: [{ id: 1, name: "My Project", path: "/my-project" }],
  })),
  useCreateProject: vi.fn(() => ({ mutate: vi.fn(), isLoading: false })),
  useDeleteProject: vi.fn(() => ({ mutate: vi.fn() })),
  getListProjectsQueryKey: vi.fn(() => ["projects"]),
  useListFeatures: vi.fn(() => ({ data: [] })),
  useListPinnedFeatures: vi.fn(() => ({ data: [] })),
  useListFeatureActivity: vi.fn(() => ({ data: [], error: null })),
  useCreateFeature: vi.fn(() => ({ mutate: vi.fn() })),
  useDeleteFeature: vi.fn(() => ({ mutate: vi.fn() })),
  useUpdateFeatureStatus: vi.fn(() => ({ mutate: vi.fn() })),
  useUpdateFeaturePinned: vi.fn(() => ({ mutate: vi.fn() })),
  useUpdateFeatureLabel: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteWorktree: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useDeleteFeatureBranch: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useKillTerminalSessions: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useCheckBranchDelete: vi.fn(() => ({
    data: { branch: "feature/a", target_branch: "main", merged: true },
    isLoading: false,
  })),
  useIsFeatureEmpty: vi.fn(() => ({
    data: { empty: false },
    isLoading: false,
    isFetching: false,
    error: null,
  })),
  useGetGitStatus: vi.fn(() => ({ data: undefined, isLoading: false })),
  getListFeaturesQueryKey: vi.fn((id: number) => ["features", "list", id]),
  getGetFeatureQueryKey: (id: number) => ["features", "detail", id],
  getGetFeatureSettingsQueryKey: (id: number) => ["features", "settings", id],
  useSetProjectSetting: vi.fn(() => ({ mutate: vi.fn() })),
  useListProjectWorktrees: vi.fn(() => ({ data: [] })),
  useListFeatureWorktrees: vi.fn(() => ({ data: [] })),
  useGetStats: vi.fn(() => ({ data: undefined })),
  useGetUnifiedAgents: vi.fn(() => ({
    data: { agents: [] },
    isLoading: false,
    isError: false,
  })),
}));

vi.mock("@/hooks/useProjectColor", () => ({
  ProjectColorDot: () => null,
}));

// Mock ProjectSettingsDialog
vi.mock("./ProjectSettingsDialog", () => ({
  ProjectSettingsDialog: () => null,
}));

vi.mock("@/lib/app-version", () => ({
  APP_VERSION: "1.2.3",
}));

const mockSetCollapsed = vi.fn();

vi.mock("@/components/SidebarContext", () => ({
  useSidebarCollapsed: () => ({ collapsed: false, setCollapsed: mockSetCollapsed }),
}));

describe("Sidebar", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockSetCollapsed.mockClear();
    mockLogoSrc = "dracula-logo.svg";
    mockLocation = { pathname: "/" };
  });

  it("renders the app name", () => {
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByText("Cadencr")).toBeInTheDocument();
  });

  it("renders the logo", () => {
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByAltText("Cadencr")).toBeInTheDocument();
  });

  it("renders the logo selected by the active theme", () => {
    mockLogoSrc = "aurora-light-logo.svg";
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByAltText("Cadencr")).toHaveAttribute("src", "aurora-light-logo.svg");
  });

  it("renders settings link", () => {
    render(<Sidebar onSearch={() => {}} />);
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("renders collapse sidebar button", () => {
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByTitle("Collapse sidebar (⌘B)")).toBeInTheDocument();
  });

  it("calls setCollapsed when collapse button is clicked", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<Sidebar onSearch={() => {}} />);
    await user.click(screen.getByTitle("Collapse sidebar (⌘B)"));
    expect(mockSetCollapsed).toHaveBeenCalledWith(true);
  });

  it("calls onSearch when the Search button is clicked", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<Sidebar onSearch={onSearch} />);
    await user.click(screen.getByTitle("Search (⌘K)"));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("shows an inactive search shortcut hint while terminal focus is active", async () => {
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByTitle("Search (⌘K)")).toBeInTheDocument();

    const terminal = document.createElement("div");
    terminal.dataset.focusZone = "terminal";
    const textarea = document.createElement("textarea");
    terminal.appendChild(textarea);
    document.body.appendChild(terminal);
    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);

    textarea.focus();

    await waitFor(() => {
      expect(screen.getByTitle("Search unavailable while terminal is focused")).toBeInTheDocument();
    });
    expect(screen.getByText("--")).toBeInTheDocument();

    outsideButton.focus();

    await waitFor(() => {
      expect(screen.getByTitle("Search (⌘K)")).toBeInTheDocument();
    });

    terminal.remove();
    outsideButton.remove();
  });

  it("renders ProjectTree with projects", () => {
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByText("My Project")).toBeInTheDocument();
  });

  it("renders app version", () => {
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByText("v1.2.3")).toBeInTheDocument();
  });

  it("renders without crashing on any route", () => {
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByText("Cadencr")).toBeInTheDocument();
  });

  it("renders on ws-session route with search params", () => {
    mockLocation = {
      pathname: "/ws-session/abc123",
      search: { projectId: 1, featureId: 3 },
    };
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByText("Cadencr")).toBeInTheDocument();
  });
});
