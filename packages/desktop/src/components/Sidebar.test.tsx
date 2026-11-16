import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/test-utils";
import { formatCompactCombo } from "@/lib/shortcuts/format";
import { getRegistryShortcut } from "@/lib/shortcuts/resolve";
import { Sidebar } from "./Sidebar";
import { collectSidebarNavItems } from "@/hooks/useSidebarKeyboardNavigation";

import type { Feature } from "@/api/generated";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";

const mockNavigate = vi.fn();
let mockPinnedFeatures: Feature[] = [];

let mockLocation: { pathname: string; search?: Record<string, unknown> } = {
  pathname: "/",
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useRouterState: (options?: {
    select?: (state: {
      location: { pathname: string; search?: Record<string, unknown> };
    }) => unknown;
  }) => {
    const state = {
      location: mockLocation,
    };
    return options?.select ? options.select(state) : state;
  },
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

// Keep the workspace-settings plumbing (useSetting → useGetWorkspaceSetting)
// out of the ProjectTree render tree pulled in by the sidebar.
vi.mock("@/lib/project-onboarding", () => ({
  useNewProjectOnboarding: () => ({
    onboardingProject: null,
    maybeOnboard: vi.fn(),
    close: vi.fn(),
  }),
  useProjectOnboardingDismissed: () => ({
    dismissed: false,
    setDismissed: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("../api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/generated")>()),
  useGetWorkspaceSetting: vi.fn(() => ({ data: { value: "true" }, isLoading: false })),
  useArchiveFeature: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useGetFeatureArchivePreview: vi.fn(() => ({
    data: { parent_ids: [], descendant_ids: [], has_relations: false },
    isLoading: false,
    isFetching: false,
    error: null,
  })),
  useListProjects: vi.fn(() => ({
    data: [{ id: 1, name: "My Project", path: "/my-project" }],
  })),
  useCreateProject: vi.fn(() => ({ mutate: vi.fn(), isLoading: false })),
  useDeleteProject: vi.fn(() => ({ mutate: vi.fn() })),
  getListProjectsQueryKey: vi.fn(() => ["projects"]),
  useListFeatures: vi.fn(() => ({ data: [] })),
  useListPinnedFeatures: vi.fn(() => ({ data: mockPinnedFeatures })),
  useListFeatureActivity: vi.fn(() => ({ data: [], error: null })),
  useListFeaturePorts: vi.fn(() => ({ data: [], error: null })),
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
  // Schedules sidebar entry (count badge).
  useListSchedules: vi.fn(() => ({ data: [], isLoading: false })),
  useCreateSchedule: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateSchedule: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteSchedule: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useSetScheduleEnabled: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useRunSchedule: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  getListSchedulesQueryKey: vi.fn(() => ["/api/schedules"]),
}));

vi.mock("@/components/ProjectBadge", () => ({
  ProjectBadge: () => null,
}));

// Mock ProjectSettingsDialog
vi.mock("./ProjectSettingsDialog", () => ({
  ProjectSettingsDialog: () => null,
}));

vi.mock("@/lib/app-version", () => ({
  APP_VERSION: "1.2.3",
}));

const mockSetCollapsed = vi.fn();
let mockSidebarCollapsed = false;

vi.mock("@/components/SidebarContext", () => ({
  useSidebarCollapsed: () => ({
    collapsed: mockSidebarCollapsed,
    setCollapsed: mockSetCollapsed,
  }),
}));

const SEARCH_TITLE = `Search (${formatCompactCombo(getRegistryShortcut("command-palette").keys)})`;
const COLLAPSE_TITLE = `Collapse sidebar (${formatCompactCombo(
  getRegistryShortcut("toggle-sidebar").keys,
)})`;

describe("Sidebar", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockPinnedFeatures = [];
    mockSetCollapsed.mockClear();
    mockSidebarCollapsed = false;
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

  it("keeps the full sidebar mounted but inaccessible while collapsing", () => {
    const { rerender } = render(<Sidebar onSearch={() => {}} />);
    const sidebar = screen.getByRole("complementary");

    mockSidebarCollapsed = true;
    rerender(<Sidebar onSearch={() => {}} />);

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(document.querySelector("[data-app-sidebar]")).toBe(sidebar);
    expect(sidebar).toHaveClass("-translate-x-2", "opacity-0", "duration-[220ms]");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(sidebar).toHaveAttribute("inert");
    expect(sidebar).toContainElement(screen.getByText("Cadencr"));
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
    expect(screen.getByTitle(COLLAPSE_TITLE)).toBeInTheDocument();
  });

  it("calls setCollapsed when collapse button is clicked", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<Sidebar onSearch={() => {}} />);
    await user.click(screen.getByTitle(COLLAPSE_TITLE));
    expect(mockSetCollapsed).toHaveBeenCalledWith(true);
  });

  it("calls onSearch when the Search button is clicked", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<Sidebar onSearch={onSearch} />);
    await user.click(screen.getByTitle(SEARCH_TITLE));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("shows an inactive search shortcut hint while terminal focus is active", async () => {
    render(<Sidebar onSearch={() => {}} />);
    expect(screen.getByTitle(SEARCH_TITLE)).toBeInTheDocument();

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
    expect(screen.getByText("-")).toBeInTheDocument();

    outsideButton.focus();

    await waitFor(() => {
      expect(screen.getByTitle(SEARCH_TITLE)).toBeInTheDocument();
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

  it("pads its surface by the safe-area insets so the rail reaches the screen edges", () => {
    // The insets live on the `<aside>` (not the mobile drawer wrapper) so
    // `bg-sidebar` extends edge-to-edge in fullscreen/standalone mobile while
    // the header/footer still clear the notch and home indicator.
    render(<Sidebar onSearch={() => {}} />);
    const aside = screen.getByRole("complementary");
    expect(aside.className).toContain("pt-[env(safe-area-inset-top)]");
    expect(aside.className).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(aside.className).toContain("pl-[env(safe-area-inset-left)]");
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

describe("collectSidebarNavItems", () => {
  it("keeps virtual sections as logical boundaries instead of recycled children", () => {
    const sidebar = document.createElement("aside");
    sidebar.innerHTML = `
      <button data-nav-item id="before"></button>
      <div data-virtual-nav-list id="virtual"><button data-nav-item id="recycled"></button></div>
      <button data-nav-item id="after"></button>
    `;
    expect(collectSidebarNavItems(sidebar).map((element) => element.id)).toEqual([
      "before",
      "virtual",
      "after",
    ]);
  });

  it("excludes rows inside an aria-hidden ancestor (closing CollapsibleSection)", () => {
    const sidebar = document.createElement("aside");
    sidebar.innerHTML = `
      <button data-nav-item id="before"></button>
      <div aria-hidden="true"><button data-nav-item id="closing"></button></div>
      <button data-nav-item id="after"></button>
    `;
    expect(collectSidebarNavItems(sidebar).map((element) => element.id)).toEqual([
      "before",
      "after",
    ]);
  });
});

describe("shared sidebar number navigation", () => {
  it("numbers pinned and project rows together and disables both while collapsed", () => {
    mockSidebarCollapsed = false;
    mockLocation = { pathname: "/" };
    mockNavigate.mockClear();
    mockPinnedFeatures = [
      {
        id: 42,
        project_id: 1,
        title: "Pinned navigation",
        runtime_provider: "codex_cli",
      } as Feature,
    ];
    const { container, rerender } = render(<Sidebar onSearch={vi.fn()} />);
    const modifier = PLATFORM_IS_MAC ? { metaKey: true } : { ctrlKey: true };
    const modKey = PLATFORM_IS_MAC ? "Meta" : "Control";
    fireEvent.keyDown(window, { key: modKey, ...modifier });
    const badges = [
      ...container.querySelectorAll('[data-nav-shortcut-badge][data-visible="true"]'),
    ];
    expect(badges.map((el) => el.textContent)).toEqual(["1", "2"]);
    expect(badges[0].closest('[data-nav-type="feature"]')).toHaveAttribute("data-nav-id", "42");
    expect(badges[1].closest('[data-nav-type="project"]')).not.toBeNull();
    fireEvent.keyDown(window, { key: "1", ...modifier });
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ featureId: 42 }) }),
    );
    const project = container.querySelector<HTMLElement>('[data-nav-type="project"]')!;
    const click = vi.spyOn(project, "click");
    fireEvent.keyDown(window, { key: "2", ...modifier });
    expect(click).toHaveBeenCalledOnce();
    mockSidebarCollapsed = true;
    rerender(<Sidebar onSearch={vi.fn()} />);
    fireEvent.keyDown(window, { key: modKey, ...modifier });
    fireEvent.keyDown(window, { key: "2", ...modifier });
    expect(click).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-nav-shortcut-badge][data-visible="true"]')).toBeNull();
    mockPinnedFeatures = [];
    mockSidebarCollapsed = false;
  });
});
