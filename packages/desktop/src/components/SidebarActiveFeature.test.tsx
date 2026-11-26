import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { ActiveSidebarSections, SidebarActiveFeatureProvider } from "./SidebarActiveFeature";

const mocks = vi.hoisted(() => ({
  location: { pathname: "/", search: {} as Record<string, unknown> },
  sectionRenders: 0,
  lastProps: {
    activeProjectId: null as number | null,
    activeFeatureId: null as number | null,
    onSelectFeature: null as ((id: number) => void) | null,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: (options?: {
    select?: (state: {
      location: { pathname: string; search?: Record<string, unknown> };
    }) => unknown;
  }) => {
    const state = { location: mocks.location };
    return options?.select ? options.select(state) : state;
  },
}));

vi.mock("@/components/SidebarSections", () => ({
  SidebarSections: ({
    activeProjectId,
    activeFeatureId,
    onSelectFeature,
  }: {
    activeProjectId: number | null;
    activeFeatureId: number | null;
    onSelectFeature: (id: number) => void;
  }) => {
    mocks.sectionRenders += 1;
    mocks.lastProps = { activeProjectId, activeFeatureId, onSelectFeature };
    return (
      <div data-testid="active-ids">
        {`${activeProjectId ?? "none"}:${activeFeatureId ?? "none"}`}
      </div>
    );
  },
}));

function renderTree() {
  return render(
    <SidebarActiveFeatureProvider>
      <ActiveSidebarSections showsSamples={false} />
    </SidebarActiveFeatureProvider>,
  );
}

describe("SidebarActiveFeature", () => {
  beforeEach(() => {
    mocks.location = {
      pathname: "/ws-session/ws-feature-1",
      search: { projectId: 1, featureId: 1 },
    };
    mocks.sectionRenders = 0;
    mocks.lastProps = { activeProjectId: null, activeFeatureId: null, onSelectFeature: null };
  });

  it("syncs selection across programmatic route changes without a second render", () => {
    const { rerender } = renderTree();
    expect(screen.getByTestId("active-ids")).toHaveTextContent("1:1");
    act(() => mocks.lastProps.onSelectFeature?.(1));

    // Programmatic switch (e.g. archive auto-advance from 1 -> 2) should render sections once.
    mocks.sectionRenders = 0;
    mocks.location = {
      pathname: "/ws-session/ws-feature-2",
      search: { projectId: 1, featureId: 2 },
    };
    rerender(
      <SidebarActiveFeatureProvider>
        <ActiveSidebarSections showsSamples={false} />
      </SidebarActiveFeatureProvider>,
    );
    expect(screen.getByTestId("active-ids")).toHaveTextContent("1:2");
    expect(mocks.sectionRenders).toBe(1);

    // Leaving for Settings retains feature 2, not the archived feature 1.
    mocks.location = { pathname: "/settings", search: {} };
    rerender(
      <SidebarActiveFeatureProvider>
        <ActiveSidebarSections showsSamples={false} />
      </SidebarActiveFeatureProvider>,
    );
    expect(screen.getByTestId("active-ids")).toHaveTextContent("none:2");
  });

  it("clears selection on the home route and keeps it cleared when visiting Settings", () => {
    const { rerender } = renderTree();
    act(() => mocks.lastProps.onSelectFeature?.(1));

    // Archiving the last conversation navigates to /?projectId=1.
    mocks.sectionRenders = 0;
    mocks.location = { pathname: "/", search: { projectId: 1 } };
    rerender(
      <SidebarActiveFeatureProvider>
        <ActiveSidebarSections showsSamples={false} />
      </SidebarActiveFeatureProvider>,
    );
    expect(screen.getByTestId("active-ids")).toHaveTextContent("1:none");
    expect(mocks.sectionRenders).toBe(1);

    // Visiting Settings afterwards does not resurrect the archived conversation.
    mocks.location = { pathname: "/settings", search: {} };
    rerender(
      <SidebarActiveFeatureProvider>
        <ActiveSidebarSections showsSamples={false} />
      </SidebarActiveFeatureProvider>,
    );
    expect(screen.getByTestId("active-ids")).toHaveTextContent("none:none");
  });
});
