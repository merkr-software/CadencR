import { memo, type ComponentType, type ReactNode, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { installSessionIntegration } from "@/lib/session-integration";

/**
 * Guards the cost of opening a conversation outside its workspace: the router
 * state changes several times per navigation (pending, loading, resolved), and
 * the root layout used to read all of it, re-rendering the sidebar, the
 * overlays and Sonner's toaster (a forced style recalculation) every time.
 */
interface MockLocation {
  pathname: string;
  search: { featureId?: number; projectId?: number };
}

interface MockRouterState {
  status: "idle" | "pending";
  location: MockLocation;
}

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const renders = { root: 0, sidebar: 0, sonner: 0, palette: 0 };
  let state: MockRouterState = {
    status: "idle",
    location: { pathname: "/ws-session/ws-feature-1", search: { featureId: 1, projectId: 1 } },
  };
  return {
    renders,
    navigate: vi.fn(),
    getState: () => state,
    setState(next: MockRouterState) {
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (opts: { component: unknown }) => ({ options: opts }),
  Outlet: () => <div data-testid="outlet" />,
  useMatch: () => undefined,
  useNavigate: () => mocks.navigate,
  // Like the real hook: one subscription, compared by identity of the selection.
  useRouterState: (options?: { select?: (state: MockRouterState) => unknown }) =>
    useSyncExternalStore(mocks.subscribe, () => {
      const state = mocks.getState();
      return options?.select ? options.select(state) : state;
    }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("@tanstack/react-hotkeys", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/hooks/useSetting", () => ({
  useSetting: vi.fn(() => ({ value: "256", setValue: vi.fn(), isLoading: false })),
  useSettingWriter: vi.fn(() => ({ setValue: vi.fn(), isSaving: false })),
}));
vi.mock("@/api/settings", () => ({
  useGetWorkspaceSettings: vi.fn(() => ({ data: [], isLoading: false })),
  settingsArrayToMap: vi.fn(() => ({})),
  getWorkspaceSettingsQueryKey: () => ["workspace", "settings"] as const,
}));

// The real sidebar is memoized; the stand-in keeps exactly that, so the test
// fails if the shell starts handing it new props or the memo goes away.
vi.mock("@/components/Sidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/Sidebar")>();
  const isMemo = (actual.Sidebar as { $$typeof?: symbol }).$$typeof === Symbol.for("react.memo");
  function CountingSidebar(): ReactNode {
    mocks.renders.sidebar += 1;
    return <div data-testid="sidebar" />;
  }
  return { Sidebar: isMemo ? memo(CountingSidebar) : CountingSidebar };
});

// A direct child of the root layout: it renders exactly when the layout does.
vi.mock("@/components/UniversalContextMenu", () => ({
  default: ({ children }: { children: ReactNode }) => {
    mocks.renders.root += 1;
    return children;
  },
}));

vi.mock("@/components/CommandPalette", () => ({
  CommandPalette: () => {
    mocks.renders.palette += 1;
    return null;
  },
}));

// Sonner's own render is the expensive one (`getComputedStyle`); the themed
// wrapper around it stays real.
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  Toaster: () => {
    mocks.renders.sonner += 1;
    return null;
  },
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));

import { Route } from "./__root";

let disposeSessionIntegration: () => void;
beforeEach(() => {
  disposeSessionIntegration = installSessionIntegration();
});
afterEach(() => {
  disposeSessionIntegration();
});

function RootLayout(): ReactNode {
  const Component = (Route as unknown as { options: { component: ComponentType } }).options
    .component;
  return <Component />;
}

function openConversation(featureId: number): void {
  const location = {
    pathname: `/ws-session/ws-feature-${featureId}`,
    search: { featureId, projectId: 1 },
  };
  // Pending with the new location, then resolved on the same one.
  act(() => mocks.setState({ status: "pending", location }));
  act(() => mocks.setState({ status: "idle", location }));
}

function resetRenders(): void {
  Object.assign(mocks.renders, { root: 0, sidebar: 0, sonner: 0, palette: 0 });
}

describe("root layout on a conversation switch", () => {
  it("renders the root once and leaves the sidebar and the toaster alone", () => {
    render(<RootLayout />);
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(mocks.renders.sonner).toBeGreaterThan(0);
    resetRenders();

    openConversation(2);

    expect(mocks.renders.root).toBe(1);
    expect(mocks.renders.sidebar).toBe(0);
    expect(mocks.renders.sonner).toBe(0);
  });

  it("ignores router updates that keep the location", () => {
    render(<RootLayout />);
    openConversation(3);
    resetRenders();

    act(() => mocks.setState({ ...mocks.getState(), status: "pending" }));
    act(() => mocks.setState({ ...mocks.getState(), status: "idle" }));

    expect(mocks.renders).toEqual({ root: 0, sidebar: 0, sonner: 0, palette: 0 });
  });
});
