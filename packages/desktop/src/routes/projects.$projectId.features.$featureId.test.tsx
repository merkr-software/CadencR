import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen } from "@/test-utils";
import React from "react";

const mocks = vi.hoisted(() => {
  const mockUseParams = vi.fn(() => ({ featureId: "1", projectId: "2" }));
  const mockUseSearch = vi.fn(() => ({}));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockGetByIdQuery = vi.fn(() => ({ data: undefined as any })) as any;
  const mockSaveLastOpened = vi.fn();
  return { mockUseParams, mockUseSearch, mockGetByIdQuery, mockSaveLastOpened };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (opts: { component: unknown }) => ({
    options: opts,
    useSearch: mocks.mockUseSearch,
    useParams: mocks.mockUseParams,
  }),
  useNavigate: () => vi.fn(),
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
  useRouterState: (options?: {
    select?: (state: {
      location: { pathname: string; search?: Record<string, unknown> };
    }) => unknown;
  }) => {
    const state = { location: { pathname: "/" } };
    return options?.select ? options.select(state) : state;
  },
  Link: ({ children, to }: { children: unknown; to: string }) => {
    const React = require("react");
    return React.createElement("a", { href: to }, children);
  },
}));

vi.mock("@/api/generated", () => ({
  useGetFeature: mocks.mockGetByIdQuery,
  useListProjects: () => ({ data: [{ id: 2, name: "Test", path: "/test" }] }),
}));

vi.mock("@/hooks/useSaveLastOpenedFeature", () => ({
  useSaveLastOpenedFeature: mocks.mockSaveLastOpened,
}));

let routeModule: { options: { component: React.ComponentType } };

beforeAll(async () => {
  const mod = await import("./projects/$projectId/features/$featureId");
  routeModule = mod.Route as unknown as { options: { component: React.ComponentType } };
});

function FeaturePage() {
  const Component = routeModule.options?.component;
  if (!Component) return null;
  return <Component />;
}

describe("FeaturePage route", () => {
  beforeEach(() => {
    mocks.mockUseParams.mockReturnValue({ featureId: "1", projectId: "2" });
    mocks.mockUseSearch.mockReturnValue({});
    mocks.mockGetByIdQuery.mockReturnValue({ data: undefined });
    mocks.mockSaveLastOpened.mockClear();
  });

  it("redirects to the ws-session route once feature loads", () => {
    mocks.mockGetByIdQuery.mockReturnValue({
      data: { id: 1, type: "ws-session", title: "My Feature" },
    });
    render(<FeaturePage />);
    const node = screen.getByTestId("navigate");
    expect(node.getAttribute("data-to")).toBe("/ws-session/$sessionId");
  });

  it("renders nothing while the feature query is loading", () => {
    const { container } = render(<FeaturePage />);
    expect(container.firstChild).toBeNull();
  });

  it("does not call useSaveLastOpenedFeature from route (handled by child views)", () => {
    mocks.mockUseParams.mockReturnValue({ featureId: "7", projectId: "3" });
    render(<FeaturePage />);
    expect(mocks.mockSaveLastOpened).not.toHaveBeenCalled();
  });

  it("renders a not-found state when the feature query 404s", () => {
    const error = Object.assign(new Error("not found"), {
      isAxiosError: true,
      response: { status: 404 },
    });
    mocks.mockGetByIdQuery.mockReturnValue({
      data: undefined,
      isError: true,
      error,
      refetch: vi.fn(),
    });
    render(<FeaturePage />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.getByText("Feature #1 not found")).toBeInTheDocument();
  });

  it("renders a generic error state with a retry for non-404 failures", () => {
    const refetch = vi.fn();
    mocks.mockGetByIdQuery.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error("network down"),
      refetch,
    });
    render(<FeaturePage />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();
    screen.getByRole("button", { name: "Retry" }).click();
    expect(refetch).toHaveBeenCalled();
  });
});
