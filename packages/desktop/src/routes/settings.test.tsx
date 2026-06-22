import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import React from "react";

const mocks = vi.hoisted(() => {
  const mockGetWorkspaceSetting = vi.fn(() => ({
    data: { value: "1" },
    isSuccess: true,
  }));
  const mockSetWorkspaceSetting = vi.fn(() => ({
    mutate: vi.fn(),
    isLoading: false,
  }));
  return { mockGetWorkspaceSetting, mockSetWorkspaceSetting };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (opts: { component: unknown }) => ({
    options: opts,
    useSearch: vi.fn(() => ({})),
    useParams: vi.fn(() => ({})),
  }),
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/settings" } }),
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
  });

  it("renders the settings heading", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("renders the sidebar nav with grouped sections", () => {
    render(<SettingsPage />);
    // sidebar nav buttons (the visible ones, not the section headings)
    expect(screen.getAllByRole("button", { name: /Appearance/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /^MCP$/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /CLI Providers/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Session Defaults/ })).not.toBeInTheDocument();
  });

  it("renders MCP as its own settings section", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "MCP" })).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /workspace memory for agents/i }),
    ).toBeInTheDocument();
  });

  it("renders runtime & models section with the model selector", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: /Runtime & Models/ })).toBeInTheDocument();
    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
  });

  it("does not render removed session autonomy or parallel defaults", () => {
    render(<SettingsPage />);
    expect(screen.queryByRole("radiogroup", { name: /agent autonomy/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Parallel agent execution/i)).not.toBeInTheDocument();
  });

  it("renders git merge-strategy radio group", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "Git" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: /merge strategy/i })).toBeInTheDocument();
    expect(screen.getByText("--no-ff")).toBeInTheDocument();
  });

  it("does not render the removed loader-style option", () => {
    render(<SettingsPage />);
    expect(screen.queryByText("Loader style")).not.toBeInTheDocument();
    expect(screen.queryByText("Usage Glow")).not.toBeInTheDocument();
  });
});
