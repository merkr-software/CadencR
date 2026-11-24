import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTarget } from "@/components/workspace-pool/workspace-pool-state";

/**
 * The stage keeps the conversation layer (and its pool) at one place in the
 * tree across the phone inbox, a fold and a layout flip, and puts the inbox
 * beside it when two panes show.
 */

interface MockMatch {
  status: "success" | "pending" | "error";
  searchError: unknown;
  params: { sessionId: string };
  search: { cwd: string; featureId: number; projectId: number };
}

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    /** The committed leaf match's pathname (what the outlet renders). */
    pathname: "/",
    /** `location.pathname`: moves when a navigation starts, before its matches commit. */
    locationPathname: "/",
    match: null as MockMatch | null,
    /** No route matched: only the root match is committed. */
    unmatched: false,
    phone: true,
    twoPanes: false,
  };
  const counts = { pool: 0, inbox: 0 };
  const targets: (WorkspaceTarget | null)[] = [];
  /** Each committed frame of the pool: the layer's state and the pool's target. */
  const frames: { layer: string | undefined; target: WorkspaceTarget | null }[] = [];
  return {
    state,
    counts,
    targets,
    frames,
    set(next: Partial<typeof state>) {
      Object.assign(state, next);
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

function useMockState<T>(read: () => T): T {
  return useSyncExternalStore(mocks.subscribe, read);
}

/** `useMatch` with `structuralSharing`: an equal selection keeps its identity. */
function useMockMatch(options: { select?: (match: MockMatch) => unknown }): unknown {
  const last = useRef<{ json: string; value: unknown } | null>(null);
  return useMockState(() => {
    const match = mocks.state.match;
    if (!match) return undefined;
    const value = options.select ? options.select(match) : match;
    const json = JSON.stringify(value) ?? "undefined";
    if (last.current?.json === json) return last.current.value;
    last.current = { json, value };
    return value;
  });
}

vi.mock("@tanstack/react-router", () => ({
  // The stage reads the committed matches (the leaf's pathname), like the outlet.
  useRouterState: (options: {
    select: (state: {
      location: { pathname: string };
      matches: { routeId: string; pathname: string }[];
    }) => unknown;
  }) =>
    useMockState(() =>
      options.select({
        location: { pathname: mocks.state.locationPathname },
        matches: mocks.state.unmatched
          ? [{ routeId: "__root__", pathname: "/" }]
          : [
              { routeId: "__root__", pathname: "/" },
              { routeId: "leaf", pathname: mocks.state.pathname },
            ],
      }),
    ),
  useMatch: useMockMatch,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => useMockState(() => mocks.state.phone),
}));
vi.mock("@/hooks/useTwoPanes", () => ({
  useTwoPanes: () => useMockState(() => mocks.state.twoPanes),
}));
vi.mock("@/components/phone-inbox/PhoneInbox", () => ({
  PhoneInbox: ({ variant }: { variant: string }) => {
    useEffect(() => {
      mocks.counts.inbox += 1;
    }, []);
    return <div data-testid="inbox-pane-content" data-variant={variant} />;
  },
}));
vi.mock("@/components/workspace-pool/WorkspacePool", () => ({
  WorkspacePool: ({ target }: { target: WorkspaceTarget | null }) => {
    useEffect(() => {
      mocks.counts.pool += 1;
    }, []);
    mocks.targets.push(target);
    useLayoutEffect(() => {
      const layer = document.querySelector<HTMLElement>("[data-conversation-layer]");
      mocks.frames.push({ layer: layer?.dataset.conversationLayer, target });
    });
    return <div data-testid="pool" data-session={target?.sessionId ?? ""} />;
  },
}));

import { RoutedStage } from "./RoutedStage";

/** Each mount of the routed page: the committed page it rendered, the location at the time. */
const outletMounts: { page: string; location: string }[] = [];

function OutletProbe(): ReactNode {
  useEffect(() => {
    outletMounts.push({ page: mocks.state.pathname, location: mocks.state.locationPathname });
  }, []);
  return <div data-testid="outlet" />;
}

const OUTLET: ReactNode = <OutletProbe />;

function conversation(featureId: number): Partial<typeof mocks.state> {
  return {
    pathname: `/ws-session/ws-feature-${featureId}`,
    locationPathname: `/ws-session/ws-feature-${featureId}`,
    match: {
      status: "success",
      searchError: undefined,
      params: { sessionId: `ws-feature-${featureId}` },
      search: { cwd: "/repo", featureId, projectId: 1 },
    },
  };
}
const INBOX = { pathname: "/", locationPathname: "/", match: null };

function layer(): HTMLElement | null {
  return document.querySelector("[data-conversation-layer]");
}

beforeEach(() => {
  Object.assign(mocks.state, {
    pathname: "/",
    locationPathname: "/",
    match: null,
    unmatched: false,
    phone: true,
    twoPanes: false,
  });
  mocks.counts.pool = 0;
  mocks.counts.inbox = 0;
  mocks.targets.length = 0;
  mocks.frames.length = 0;
  outletMounts.length = 0;
});
afterEach(cleanup);

describe("RoutedStage on a phone, one pane", () => {
  it("keeps the conversation mounted across the inbox", () => {
    render(<RoutedStage outlet={OUTLET} />);
    // The inbox page: the pool is mounted, every workspace hidden, presses pass through.
    expect(layer()?.dataset.conversationLayer).toBe("hidden");
    expect(layer()?.className).toContain("pointer-events-none");
    expect(mocks.targets.at(-1)).toBeNull();

    act(() => mocks.set(conversation(7)));
    const pool = screen.getByTestId("pool");
    expect(layer()?.dataset.conversationLayer).toBe("shown");
    expect(pool.dataset.session).toBe("ws-feature-7");

    act(() => mocks.set(INBOX));
    expect(screen.getByTestId("pool")).toBe(pool);
    expect(mocks.targets.at(-1)).toBeNull();

    act(() => mocks.set(conversation(7)));
    expect(screen.getByTestId("pool")).toBe(pool);
    expect(mocks.counts.pool).toBe(1);
    expect(document.querySelector("[data-stage-pane='inbox']")).toBeNull();
  });

  it("never shows the layer without a conversation going to and from the inbox", () => {
    render(<RoutedStage outlet={OUTLET} />);
    // Each navigation moves the location first, then commits its matches.
    const navigate = (next: Partial<typeof mocks.state>): void => {
      act(() => mocks.set({ locationPathname: next.locationPathname }));
      act(() => mocks.set(next));
    };
    navigate(conversation(7));
    navigate(INBOX);
    navigate(conversation(8));
    navigate(INBOX);
    expect(mocks.frames.length).toBeGreaterThan(0);
    for (const frame of mocks.frames) {
      expect(frame.layer === "shown").toBe(frame.target !== null);
    }
    // The page remounts when its matches commit, never with the old page
    // when only the location moved.
    expect(outletMounts).toHaveLength(5);
    for (const mount of outletMounts) expect(mount.page).toBe(mount.location);
    expect(mocks.counts.inbox).toBe(0);
  });

  it("leaves a conversation link that did not resolve to the route's error UI", () => {
    render(<RoutedStage outlet={OUTLET} />);
    const broken = conversation(9);
    act(() =>
      mocks.set({
        ...broken,
        match: broken.match && {
          ...broken.match,
          status: "error",
          searchError: new Error("featureId search param is required"),
        },
      }),
    );
    expect(layer()?.dataset.conversationLayer).toBe("hidden");
    expect(layer()?.className).toContain("pointer-events-none");
    expect(mocks.targets.at(-1)).toBeNull();
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });

  it("does not re-render the pool when only the match's bookkeeping changes", () => {
    render(<RoutedStage outlet={OUTLET} />);
    act(() => mocks.set(conversation(4)));
    const renders = mocks.targets.length;
    const current = mocks.state.match;
    act(() => mocks.set({ match: current && { ...current } }));
    expect(mocks.targets.length).toBe(renders);
  });

  it("unmounts the conversations on any other page", () => {
    render(<RoutedStage outlet={OUTLET} />);
    act(() => mocks.set({ pathname: "/settings", locationPathname: "/settings", match: null }));
    expect(layer()).toBeNull();
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });
});

describe("RoutedStage with two panes", () => {
  it("puts the inbox beside the conversation, which keeps its place when the panes come and go", () => {
    mocks.state.twoPanes = true;
    render(<RoutedStage outlet={OUTLET} />);
    // `#/`: the inbox on the left, the routed page (Pick a conversation) on the right.
    expect(screen.getByTestId("inbox-pane-content").dataset.variant).toBe("pane");
    expect(document.querySelector("[data-stage-panes]")?.getAttribute("data-stage-panes")).toBe(
      "2",
    );
    expect(screen.getByTestId("outlet")).toBeInTheDocument();

    // A card opens the conversation in the right pane; the inbox stays.
    act(() => mocks.set(conversation(3)));
    const pool = screen.getByTestId("pool");
    const main = document.querySelector("[data-stage-pane='main']");
    expect(pool.dataset.session).toBe("ws-feature-3");
    expect(mocks.counts.inbox).toBe(1);

    // Folding: one pane, the same conversation, not remounted.
    act(() => mocks.set({ twoPanes: false }));
    expect(document.querySelector("[data-stage-pane='inbox']")).toBeNull();
    expect(screen.getByTestId("pool")).toBe(pool);
    expect(document.querySelector("[data-stage-pane='main']")).toBe(main);

    // Unfolding with the conversation open: inbox + that conversation.
    act(() => mocks.set({ twoPanes: true }));
    expect(screen.getByTestId("inbox-pane-content")).toBeInTheDocument();
    expect(screen.getByTestId("pool")).toBe(pool);
    expect(mocks.counts.pool).toBe(1);
  });

  it("shows one pane on other pages", () => {
    mocks.state.twoPanes = true;
    render(<RoutedStage outlet={OUTLET} />);
    act(() => mocks.set({ pathname: "/schedules", locationPathname: "/schedules", match: null }));
    expect(document.querySelector("[data-stage-pane='inbox']")).toBeNull();
  });
  it("never takes a page no route matched for the phone home", () => {
    mocks.state.twoPanes = true;
    render(<RoutedStage outlet={OUTLET} />);
    act(() => mocks.set({ unmatched: true, locationPathname: "/nowhere", match: null }));
    expect(document.querySelector("[data-stage-pane='inbox']")).toBeNull();
    expect(screen.queryByTestId("pool")).toBeNull();
  });
});

describe("RoutedStage across a layout flip", () => {
  it("keeps the conversation when the phone layout gives way to the desktop one", () => {
    render(<RoutedStage outlet={OUTLET} />);
    act(() => mocks.set(conversation(5)));
    const pool = screen.getByTestId("pool");
    act(() => mocks.set({ phone: false }));
    expect(screen.getByTestId("pool")).toBe(pool);
    act(() => mocks.set({ phone: true }));
    expect(screen.getByTestId("pool")).toBe(pool);
    expect(mocks.counts.pool).toBe(1);
  });

  it("does not keep conversations behind the desktop home", () => {
    mocks.state.phone = false;
    render(<RoutedStage outlet={OUTLET} />);
    expect(layer()).toBeNull();
  });
});
