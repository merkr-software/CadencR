import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@/test-utils";
import type { Feature } from "@/api/generated";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useSidebarFilterStore } from "@/stores/sidebar-filter-store";
import { useUnreadStore } from "@/stores/unread-store";
import { SidebarAttentionProvider } from "./SidebarAttentionProvider";
import { SidebarRecentSection } from "./SidebarRecentSection";

const recent = vi.hoisted(() => ({
  result: {
    data: undefined as Feature[] | undefined,
    isPending: false,
    error: null as unknown,
    refetch: () => Promise.resolve(),
  },
  calls: [] as { params: unknown; enabled: unknown }[],
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListRecentFeatures: (params: unknown, options: { query: { enabled: unknown } }) => {
    recent.calls.push({ params, enabled: options.query.enabled });
    return recent.result;
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/PinnedConversationRow", () => ({
  PinnedConversationRow: ({ feature }: { feature: Feature }) => (
    <div role="row">{feature.title}</div>
  ),
}));

function feature(id: number, title: string): Feature {
  return { id, title, project_id: 1, status: "active" } as Feature;
}

function section() {
  return (
    <SidebarAttentionProvider>
      <SidebarRecentSection activeFeatureId={null} onSelectFeature={vi.fn()} />
    </SidebarAttentionProvider>
  );
}

beforeEach(() => {
  recent.calls = [];
  recent.result = {
    data: [feature(4, "Newest"), feature(3, "Older"), feature(2, "Oldest"), feature(1, "Out")],
    isPending: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve()),
  };
  useSidebarFilterStore.getState().close();
  useSessionStatusStore.setState({ bySession: {} });
  useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {} });
  useSidebarConfigStore.setState({
    config: { ...DEFAULT_SIDEBAR_CONFIG, recentBlock: true, recentCount: "3" },
  });
});

describe("SidebarRecentSection", () => {
  it("fetches one list of 10 and shows the configured count", () => {
    render(section());
    const block = screen.getByRole("region", { name: "Recent" });
    expect(
      within(block)
        .getAllByRole("row")
        .map((row) => row.textContent),
    ).toEqual(["Newest", "Older", "Oldest"]);
    expect(recent.calls.at(-1)).toEqual({ params: { limit: 10 }, enabled: true });
  });

  it("doesn't fetch while off or filtering", () => {
    useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
    const { unmount } = render(section());
    expect(screen.queryByRole("region", { name: "Recent" })).not.toBeInTheDocument();
    expect(recent.calls).toHaveLength(0);
    unmount();

    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, recentBlock: true } });
    useSidebarFilterStore.getState().start("x", null);
    render(section());
    expect(screen.queryByRole("region", { name: "Recent" })).not.toBeInTheDocument();
    expect(recent.calls.at(-1)?.enabled).toBe(false);
  });

  it("refetches when a turn starts, since a message was just sent", () => {
    render(section());
    expect(recent.result.refetch).not.toHaveBeenCalled();
    act(() =>
      useSessionStatusStore.setState({
        bySession: { 7: { featureId: 9, status: "agent", kind: null, seq: 1 } },
      }),
    );
    expect(recent.result.refetch).toHaveBeenCalledTimes(1);
    // The turn ending is not a new message.
    act(() => useSessionStatusStore.setState({ bySession: {} }));
    expect(recent.result.refetch).toHaveBeenCalledTimes(1);
  });

  it("shows a skeleton while loading and the error inline", () => {
    recent.result = { ...recent.result, data: undefined, isPending: true };
    const { rerender } = render(section());
    expect(screen.getByLabelText("Loading Recent")).toBeInTheDocument();

    recent.result = { ...recent.result, isPending: false, error: new Error("boom") };
    rerender(section());
    expect(screen.getByRole("alert")).toHaveTextContent(/recent conversations|boom/);
  });
});
