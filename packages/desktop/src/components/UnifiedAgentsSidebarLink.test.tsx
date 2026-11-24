import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { PhoneInboxSidebarLink, UnifiedAgentsSidebarLink } from "./UnifiedAgentsSidebarLink";
import { useSessionStatusStore, type SessionStatusEntry } from "@/stores/session-status-store";

const router = vi.hoisted(() => ({ location: { pathname: "/", searchStr: "" } }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: (options?: {
    select?: (state: { location: { pathname: string; searchStr: string } }) => unknown;
  }) => (options?.select ? options.select(router) : router),
  Link: ({ children, to, className }: { children: unknown; to: string; className?: string }) => {
    const React = require("react");
    return React.createElement("a", { href: to, className }, children);
  },
}));

// Tooltip wrapper is irrelevant here — render its children directly so the
// test sees the badge without pulling in Radix's portal/provider machinery.
vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));

function seedSession(sessionId: number, entry: SessionStatusEntry): void {
  useSessionStatusStore.setState((s) => ({
    bySession: { ...s.bySession, [sessionId]: entry },
  }));
}

function dotSpan(): HTMLElement {
  // The badge wrapper carries the `title`; its first child is the dot.
  const badge = screen.getByTitle(/working/);
  return badge.firstElementChild as HTMLElement;
}

describe("UnifiedAgentsSidebarLink", () => {
  afterEach(() => useSessionStatusStore.setState({ bySession: {} }));

  it("shows a grey idle dot and 0 when no agents are working", () => {
    render(<UnifiedAgentsSidebarLink />);
    expect(screen.getByTitle("No agents working")).toBeInTheDocument();
    expect(dotSpan().className).toContain("bg-muted-foreground/40");
    expect(dotSpan().className).not.toContain("animate-pulse");
  });

  it("shows a breathing blue dot and the live count when agents are working", () => {
    seedSession(1, { status: "agent", kind: null, featureId: 10, seq: 1 });
    seedSession(2, { status: "agent", kind: null, featureId: 11, seq: 2 });
    // `question` / `idle` must not inflate the count.
    seedSession(3, { status: "question", kind: "permission", featureId: 12, seq: 3 });
    seedSession(4, { status: "idle", kind: null, featureId: 13, seq: 4 });

    render(<UnifiedAgentsSidebarLink />);
    expect(screen.getByTitle("2 agents working")).toBeInTheDocument();
    expect(dotSpan().className).toContain("bg-blue-500");
    expect(dotSpan().className).toContain("animate-pulse");
  });

  it("updates live when a session flips to working without any REST refetch", () => {
    render(<UnifiedAgentsSidebarLink />);
    expect(screen.getByTitle("No agents working")).toBeInTheDocument();

    act(() => seedSession(1, { status: "agent", kind: null, featureId: 10, seq: 1 }));
    expect(screen.getByTitle("1 agent working")).toBeInTheDocument();
    expect(dotSpan().className).toContain("animate-pulse");

    act(() => seedSession(1, { status: "idle", kind: null, featureId: 10, seq: 2 }));
    expect(screen.getByTitle("No agents working")).toBeInTheDocument();
  });
});

describe("PhoneInboxSidebarLink", () => {
  afterEach(() => {
    router.location = { pathname: "/", searchStr: "" };
  });

  it("opens the inbox on the home page and shows as current there", () => {
    render(<PhoneInboxSidebarLink />);
    const link = screen.getByRole("link", { name: /Agents/ });
    expect(link).toHaveAttribute("href", "/");
    expect(link.className.split(" ")).toContain("bg-accent/50");
  });

  it("is not current on a project asked for by link, which is no inbox", () => {
    router.location = { pathname: "/", searchStr: "?projectId=3" };
    render(<PhoneInboxSidebarLink />);
    const link = screen.getByRole("link", { name: /Agents/ });
    expect(link.className.split(" ")).not.toContain("bg-accent/50");
  });
});
