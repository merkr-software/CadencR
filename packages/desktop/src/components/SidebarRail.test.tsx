import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { createTestQueryClient } from "@/test-utils";
import { getGetFeatureQueryKey, getListProjectsQueryKey, type Feature } from "@/api/generated";
import { DEFAULT_SIDEBAR_CONFIG, type SidebarConfig } from "@/lib/sidebar-config";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useUnreadStore } from "@/stores/unread-store";
import { SidebarAttentionProvider } from "./SidebarAttentionProvider";
import { SidebarRail } from "./SidebarRail";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: unknown; to: string }) => {
    const React = require("react");
    return React.createElement("a", { ...props, href: to }, children);
  },
  useNavigate: () => vi.fn(),
  useRouterState: (options?: {
    select?: (state: {
      location: { pathname: string; search?: Record<string, unknown> };
    }) => unknown;
  }) => {
    const state = { location: { pathname: "/", search: {} } };
    return options?.select ? options.select(state) : state;
  },
}));
vi.mock("@/components/SidebarPendingGatePopover", () => ({
  SidebarPendingGatePopover: () => <button type="button">Pending request</button>,
}));

function seededClient() {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
  client.setQueryData(getListProjectsQueryKey(), [
    { id: 9, name: "cadencr", path: "/c" },
    { id: 8, name: "landing", path: "/l" },
  ]);
  for (const [id, title] of [
    [1, "Waits"],
    [2, "Works"],
  ] as const) {
    client.setQueryData(getGetFeatureQueryKey(id), {
      id,
      title,
      project_id: 9,
      status: "active",
    } as Feature);
  }
  for (const projectId of [8, 9]) client.setQueryData([`/api/projects/${projectId}/settings`], []);
  return client;
}

function renderRail(rail: SidebarConfig["rail"]) {
  useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, rail } });
  return render(
    <SidebarAttentionProvider>
      <SidebarRail onExpand={vi.fn()} />
    </SidebarAttentionProvider>,
    { queryClient: seededClient() },
  );
}

beforeEach(() => {
  useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {} });
  useSessionStatusStore.setState({
    bySession: {
      10: { featureId: 1, status: "question", kind: "permission", seq: 1 },
      11: { featureId: 2, status: "agent", kind: null, seq: 2 },
    },
  });
});

describe("SidebarRail", () => {
  it("shows each project with what it holds", () => {
    renderRail("projects");
    expect(screen.getByRole("button", { name: "cadencr: 1 waiting, 1 working" })).toBeVisible();
    expect(screen.getByRole("button", { name: "landing" })).toBeVisible();
  });

  it("lists active conversations, or only the ones waiting on you", () => {
    const { unmount } = renderRail("conversations");
    expect(screen.getByRole("button", { name: "Waits: Waiting on you" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Works: Working" })).toBeVisible();
    // A waiting conversation can be answered from the rail.
    expect(screen.getByRole("button", { name: "Pending request" })).toBeVisible();
    unmount();

    renderRail("attention");
    expect(screen.getByRole("button", { name: "Waits: Waiting on you" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Works: Working" })).not.toBeInTheDocument();
  });

  it("expands from its top and opens Settings from its foot", () => {
    renderRail("projects");
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings).toHaveAttribute("href", "/settings");
    const nav = expand.closest("nav");
    expect(nav?.firstElementChild?.nextElementSibling).toBe(expand);
    expect(nav?.lastElementChild).toBe(settings);
  });

  it("is gone when switched off", () => {
    const { container } = renderRail("none");
    expect(container).toBeEmptyDOMElement();
  });
});
