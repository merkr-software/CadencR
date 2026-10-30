import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { useSidebarCollapsed } from "@/components/SidebarContext";

/**
 * Guards the 0.11.3 regression where `Cmd+B` faded the sidebar out but left its
 * panel reserving the width. Mounts the real `ui/resizable` — the mock in
 * `__root.test.tsx` cannot show it — and toggles through `SidebarContext`.
 */
const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    mockNavigate: vi.fn(),
    width: { value: "256" as string | null, isFetched: true },
    widthWrites: [] as string[],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadWidth(value: string) {
      this.width = { value, isFetched: true };
      listeners.forEach((listener) => listener());
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (opts: { component: unknown }) => ({ options: opts }),
  Outlet: () => {
    const { collapsed, setCollapsed } = useSidebarCollapsed();
    return (
      <button type="button" data-testid="toggle" onClick={() => setCollapsed(!collapsed)}>
        toggle
      </button>
    );
  },
  useMatch: () => undefined,
  useNavigate: () => mocks.mockNavigate,
  useRouterState: (options?: {
    select?: (state: {
      location: { pathname: string; search?: Record<string, unknown> };
    }) => unknown;
  }) => {
    const state = { location: { pathname: "/" } };
    return options?.select ? options.select(state) : state;
  },
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("@tanstack/react-hotkeys", () => ({ useHotkeys: vi.fn() }));

vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: (key: string) => {
    const width = useSyncExternalStore(mocks.subscribe, () => mocks.width);
    const [value, setStored] = useState<string | null>(null);
    const setValue = useCallback((next: string) => setStored(next), []);
    if (key === "sidebar_left_width") {
      const setWidth = (next: string) => mocks.widthWrites.push(next);
      return { ...width, isLoading: false, setValue: setWidth, isSaving: false };
    }
    return { value, setValue, isLoading: false, isFetched: true, isSaving: false };
  },
  useDebouncedSettingFromMap: () => ({ value: "256", setValue: vi.fn(), isLoading: false }),
}));

vi.mock("@/api/settings", () => ({
  useGetWorkspaceSettings: vi.fn(() => ({ data: [], isLoading: false })),
  settingsArrayToMap: vi.fn(() => ({})),
  getWorkspaceSettingsQueryKey: () => ["workspace", "settings"] as const,
}));

vi.mock("@/components/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

vi.mock("@/components/CommandPalette", () => ({ CommandPalette: () => null }));

import { Route } from "./__root";
import { cleanup } from "@testing-library/react";
import { installSessionIntegration } from "@/lib/session-integration";

// These fixtures mount the route without main.tsx's application composition.
let disposeSessionIntegration: () => void;
beforeEach(() => {
  disposeSessionIntegration = installSessionIntegration();
});
afterEach(() => {
  cleanup();
  disposeSessionIntegration();
});

const GROUP_WIDTH = 800;
const GROUP_HEIGHT = 600;

function RootLayout() {
  const Component = (Route as unknown as { options: { component: ComponentType } }).options
    .component;
  return <Component />;
}

function sidebarPanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>("#sidebar");
  if (!panel) throw new Error("sidebar panel not rendered");
  return panel;
}

function sidebarWidth(): number {
  return (Number(sidebarPanel().style.flexGrow) / 100) * GROUP_WIDTH;
}

describe("global sidebar collapse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.width = { value: "256", isFetched: true };
    mocks.widthWrites = [];
  });

  it("hands the sidebar's width back to the main panel and takes it back", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, GROUP_WIDTH, GROUP_HEIGHT),
    );
    render(<RootLayout />);
    const expandedGrow = sidebarPanel().style.flexGrow;
    expect(Number(expandedGrow)).toBeGreaterThan(0);

    act(() => screen.getByTestId("toggle").click());
    expect(sidebarPanel().style.flexGrow).toBe("0");

    act(() => screen.getByTestId("toggle").click());
    expect(sidebarPanel().style.flexGrow).toBe(expandedGrow);
  });

  it("applies a stored width that loads after mount and expands back to it", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, GROUP_WIDTH, GROUP_HEIGHT),
    );
    // Pixel sizes resolve against the panels' offsetWidth, which jsdom leaves at 0.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.hasAttribute("data-panel")) return 0;
      const grow = Number.parseFloat(this.style.flexGrow);
      return Number.isFinite(grow) ? (grow / 100) * GROUP_WIDTH : GROUP_WIDTH / 2;
    });
    // The width query has not started yet: not loading, but not fetched either.
    mocks.width = { value: null, isFetched: false };
    render(<RootLayout />);
    // The mount-time layout event must not persist the default over the stored width.
    expect(mocks.widthWrites).toEqual([]);
    act(() => mocks.loadWidth("320"));
    expect(sidebarWidth()).toBeCloseTo(320);

    act(() => screen.getByTestId("toggle").click());
    expect(sidebarPanel().style.flexGrow).toBe("0");

    act(() => screen.getByTestId("toggle").click());
    expect(sidebarWidth()).toBeCloseTo(320);
  });
});
