import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@/test-utils";
import React from "react";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import { SETTINGS_PAGES } from "@/components/settings/settings-catalog";
import {
  availableSettingsGroups,
  currentSettingsPlatform,
} from "@/components/settings/settings-availability";

const mocks = vi.hoisted(() => {
  const mockGetWorkspaceSetting = vi.fn(() => ({
    data: { value: "1" },
    isSuccess: true,
  }));
  const mockSetWorkspaceSetting = vi.fn(() => ({
    mutate: vi.fn(),
    isLoading: false,
  }));
  const mockUseSearch = vi.fn(() => ({}) as { section?: string });
  return { mockGetWorkspaceSetting, mockSetWorkspaceSetting, mockUseSearch };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (opts: { component: unknown }) => ({
    options: opts,
    useSearch: mocks.mockUseSearch,
    useParams: vi.fn(() => ({})),
  }),
  useNavigate: () => vi.fn(),
  useSearch: (options?: { select?: (search: Record<string, unknown>) => unknown }) => {
    const search: Record<string, unknown> = mocks.mockUseSearch();
    return options?.select ? options.select(search) : search;
  },
  useRouterState: (options?: {
    select?: (state: {
      location: { pathname: string; search?: Record<string, unknown> };
    }) => unknown;
  }) => {
    const state = { location: { pathname: "/settings" } };
    return options?.select ? options.select(state) : state;
  },
  Link: ({ children, to }: { children: unknown; to: string }) => {
    const React = require("react");
    return React.createElement("a", { href: to }, children);
  },
}));

vi.mock("@tanstack/react-hotkeys", () => ({ useHotkeys: vi.fn() }));
vi.mock("../api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/generated")>()),
  useGetWorkspaceSetting: mocks.mockGetWorkspaceSetting,
  useSetWorkspaceSetting: mocks.mockSetWorkspaceSetting,
  getGetWorkspaceSettingQueryKey: vi.fn((key: string) => ["workspace", "setting", key]),
}));

vi.mock("../components/ModelSelector", () => ({
  ModelSelector: ({ level }: { level: string }) => (
    <div data-testid="model-selector" data-level={level}>
      ModelSelector
    </div>
  ),
}));

import { Route } from "./settings";

function SettingsPage() {
  const Component = (Route as unknown as { options: { component: React.ComponentType } }).options
    ?.component;
  if (!Component) return null;
  return <Component />;
}

describe("SettingsPage route", () => {
  beforeEach(() => {
    mocks.mockGetWorkspaceSetting.mockReturnValue({
      data: { value: "1" },
      isSuccess: true,
    });
    mocks.mockUseSearch.mockReturnValue({});
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  });

  it("renders the settings heading", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("renders the rail with every page, grouped", () => {
    render(<SettingsPage />);
    const rail = screen.getByRole("navigation", { name: "Settings pages" });
    for (const group of ["Preferences", "Agents", "Tools", "System"]) {
      expect(within(rail).getByRole("group", { name: group })).toBeInTheDocument();
    }
    expect(within(rail).getByRole("button", { name: "Appearance" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "MCP servers" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Providers" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: /Session Defaults/ })).not.toBeInTheDocument();
  });

  it("shows one page at a time", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { level: 2, name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Git" })).not.toBeInTheDocument();
  });

  it("renders MCP as its own settings page", () => {
    mocks.mockUseSearch.mockReturnValue({ section: "mcp" });
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "MCP servers" })).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /workspace memory for agents/i }),
    ).toBeInTheDocument();
  });

  it("renders conversation naming on the Agents page with the model selector and prompt", () => {
    mocks.mockUseSearch.mockReturnValue({ section: "auto-naming" });
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "Conversation names" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Naming prompt" })).toBeInTheDocument();
    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
  });

  it("does not render removed session autonomy or parallel defaults", () => {
    mocks.mockUseSearch.mockReturnValue({ section: "agents" });
    render(<SettingsPage />);
    expect(screen.queryByRole("radiogroup", { name: /agent autonomy/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Parallel agent execution/i)).not.toBeInTheDocument();
  });

  it("renders git merge-strategy radio group", () => {
    mocks.mockUseSearch.mockReturnValue({ section: "git" });
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "Git" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: /merge strategy/i })).toBeInTheDocument();
    expect(screen.getByText("--no-ff")).toBeInTheDocument();
  });

  it("scrolls a ?section deep link to the anchor it names", () => {
    // The forge onboarding button in the PR pane sends the user here. Both
    // halves are silent when broken: a renamed anchor id resolves to nothing and
    // strands the user at the top of the page with no error at all.
    mocks.mockUseSearch.mockReturnValue({ section: FORGE_SETTINGS_ANCHOR });

    const { container } = render(<SettingsPage />);

    const anchor = container.querySelector(`#${FORGE_SETTINGS_ANCHOR}`);
    expect(anchor).not.toBeNull();
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts).toContain(anchor);
  });

  // jsdom is a desktop-width plain browser: the catalog drops what such a
  // client never renders (push, the notch, the OS test notification), and every
  // anchor it still offers must exist on its page.
  const offered = availableSettingsGroups(currentSettingsPlatform(false)).flatMap(
    (group) => group.pages,
  );

  it.each(offered.map((page) => [page.id, page] as const))(
    "renders every anchor the %s page's search entries point at",
    (id, page) => {
      mocks.mockUseSearch.mockReturnValue({ section: id });
      const { container } = render(<SettingsPage />);
      expect(container.querySelector(`#settings-page-${id}`)).not.toBeNull();
      for (const entry of page.entries) {
        if (!entry.anchor) continue;
        expect(container.querySelector(`#${entry.anchor}`), entry.label).not.toBeNull();
      }
    },
  );

  it("offers every page in the catalog", () => {
    expect(offered.map((page) => page.id)).toEqual(SETTINGS_PAGES.map((page) => page.id));
  });

  it("leaves the page at the top when no section is requested", () => {
    render(<SettingsPage />);

    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not render the removed loader-style option", () => {
    mocks.mockUseSearch.mockReturnValue({ section: "appearance" });
    render(<SettingsPage />);
    expect(screen.queryByText("Loader style")).not.toBeInTheDocument();
    expect(screen.queryByText("Usage Glow")).not.toBeInTheDocument();
  });
});
