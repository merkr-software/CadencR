import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@/test-utils";
import {
  getGetFeatureQueryKey,
  getGetProjectSettingsQueryKey,
  type Feature,
  type PrStatusSnapshot,
} from "@/api/generated";
import { createTestQueryClient } from "@/test-utils";
import { DEFAULT_SIDEBAR_CONFIG, type SidebarConfig } from "@/lib/sidebar-config";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useSidebarFilterStore } from "@/stores/sidebar-filter-store";
import { useUnreadStore } from "@/stores/unread-store";
import { usePrStatusStore } from "@/stores/usePrStatusStore";
import { SidebarAttentionProvider } from "./SidebarAttentionProvider";
import { SidebarForMeSection } from "./SidebarForMeSection";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/useFeaturePrefetch", () => ({ useFeaturePrefetch: () => vi.fn() }));
vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));
// The block's rows get the tree's worktree, shell and port details.
vi.mock("@/hooks/usePinnedActivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/usePinnedActivity")>()),
  usePinnedActivity: () => ({
    shellCountByFeatureId: new Map([[1, 2]]),
    liveWorktreeFeatureIds: new Set([1]),
    worktreeByFeatureId: new Map([
      [1, { feature_id: 1, worktree_branch: "feature/fix-flaky", live: true }],
    ]),
  }),
}));
vi.mock("@/hooks/useFeaturePorts", () => ({
  NO_PORTS: [],
  useFeaturePorts: () => new Map([[1, [{ port: 5173 }]]]),
}));

const FEATURES = [
  [1, "Asks permission"],
  [2, "Finished"],
  [3, "Still working"],
  [4, "Crashed"],
  [5, "Asked first"],
  [6, "Checks failing"],
  [7, "Approved"],
] as const;

function seededClient() {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
  client.setQueryData(["/api/projects"], []);
  client.setQueryData(getGetProjectSettingsQueryKey(9), []);
  // What the rows' request lines load: the verbs read the same cache.
  for (const [featureId, kind] of [
    [1, "permission"],
    [5, "question"],
  ] as const) {
    client.setQueryData(["/api/features", featureId, "pending-gate", `request-${featureId}`], {
      kind,
      request_id: `request-${featureId}`,
      session_id: featureId,
      payload: {},
    });
  }
  for (const [id, title] of FEATURES) {
    client.setQueryData(getGetFeatureQueryKey(id), {
      id,
      title,
      project_id: 9,
      status: "active",
    } as Feature);
  }
  return client;
}

function pullRequest(
  featureId: number,
  ci: "failing" | "passing",
  review: "approved" | "pending",
  updatedAt: string,
): PrStatusSnapshot {
  return {
    feature_id: featureId,
    fetched_at: 0,
    setup_required: false,
    ci: { state: ci, checks: [] },
    pr: {
      number: featureId * 10,
      state: "open",
      title: "PR",
      source_branch: "branch",
      target_branch: "main",
      review_state: review,
      pr_label: "Pull request",
      author: { username: "you" },
      body_markdown: "",
      head_sha: "",
      updated_at: updatedAt,
      url: "",
    },
  };
}

function configure(values: Partial<SidebarConfig>): void {
  useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, ...values } });
}

function renderSection(queryClient = seededClient()) {
  return render(
    <SidebarAttentionProvider>
      <SidebarForMeSection activeFeatureId={null} onSelectFeature={vi.fn()} />
    </SidebarAttentionProvider>,
    { queryClient },
  );
}

const section = () => screen.getByRole("region", { name: "For me" });

/** Each row as "verb title", in order. */
function rowLabels(): string[] {
  return [...section().querySelectorAll('[data-nav-type="feature"]')].map((row) =>
    [
      row.querySelector("[data-feature-next-action]")?.textContent,
      row.querySelector("[data-feature-title]")?.textContent,
    ].join(" "),
  );
}

beforeEach(() => {
  configure({});
  useSidebarFilterStore.getState().close();
  useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {}, prAcks: {} });
  useSessionStatusStore.setState({
    bySession: {
      10: { featureId: 1, status: "question", kind: "permission", seq: 8, requestId: "request-1" },
      11: { featureId: 3, status: "agent", kind: null, seq: 9 },
      12: { featureId: 5, status: "question", kind: "question", seq: 2, requestId: "request-5" },
    },
  });
  usePrStatusStore.setState({
    byFeature: {
      6: pullRequest(6, "failing", "pending", "2026-10-01T10:00:00Z"),
      7: pullRequest(7, "passing", "approved", "2026-10-02T10:00:00Z"),
      // An agent at work: nothing to do there yet, whatever its pull request says.
      3: pullRequest(3, "failing", "pending", "2026-10-01T09:00:00Z"),
    },
  });
  useUnreadStore.getState().markUnread(2);
  useUnreadStore.getState().markFailed(4);
});

describe("SidebarForMeSection", () => {
  it("shows a row's branch, shells and ports, as the project tree does", () => {
    configure({ branch: true });
    renderSection();
    const row = section().querySelector('[data-nav-id="1"]');
    expect(row?.querySelector("[data-feature-branch]")).toHaveTextContent("feature/fix-flaky");
    expect(within(row as HTMLElement).getByLabelText("2 shell commands running")).toBeTruthy();
    expect(within(row as HTMLElement).getByLabelText(/5173/)).toBeTruthy();
  });

  it("lists the next actions most urgent first, each led by its verb, up to the limit", async () => {
    const { user } = renderSection();
    expect(rowLabels()).toEqual([
      "Answer Asked first",
      "Approve Asks permission",
      "Check error Crashed",
    ]);
    // The counter names every action; the strong ones (pending, failed) are read out.
    expect(within(section()).getByRole("button", { name: /For me/ })).toHaveTextContent(
      "6, 3 need an action",
    );

    await user.click(within(section()).getByRole("button", { name: "Show 3 more" }));
    expect(rowLabels()).toEqual([
      "Answer Asked first",
      "Approve Asks permission",
      "Check error Crashed",
      "Fix CI Checks failing",
      "Review Finished",
      "Merge Approved",
    ]);

    await user.click(within(section()).getByRole("button", { name: "Show less" }));
    expect(rowLabels()).toHaveLength(3);
  });

  it("shows 5 or every action per the limit option", () => {
    configure({ forMeLimit: "5" });
    const { unmount } = renderSection();
    expect(rowLabels()).toHaveLength(5);
    expect(within(section()).getByRole("button", { name: "Show 1 more" })).toBeInTheDocument();
    unmount();

    configure({ forMeLimit: "all" });
    renderSection();
    expect(rowLabels()).toHaveLength(6);
    expect(section().querySelector("[data-sidebar-show-more]")).toBeNull();
  });

  it("lets the sidebar's keyboard navigation reach and toggle Show more", () => {
    renderSection();
    const toggle = within(section()).getByRole("button", { name: "Show 3 more" });
    expect(toggle).toHaveAttribute("data-nav-item");
    expect(toggle).not.toHaveAttribute("data-nav-type");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("drops a conversation once handled and hides when nothing is left", () => {
    renderSection();
    act(() => {
      useUnreadStore.getState().markRead(2);
      useUnreadStore.getState().markRead(4);
      useSessionStatusStore.setState({ bySession: {} });
      usePrStatusStore.setState({ byFeature: {} });
    });
    expect(screen.queryByRole("region", { name: "For me" })).not.toBeInTheDocument();
  });

  it("marks an entry done from its row's check, except a pending request", async () => {
    configure({ forMeLimit: "all" });
    const { user } = renderSection();
    const row = (title: string) =>
      within(section()).getByText(title).closest('[data-nav-type="feature"]') as HTMLElement;
    expect(within(row("Asks permission")).queryByRole("button", { name: "Mark done" })).toBeNull();

    await user.click(within(row("Checks failing")).getByRole("button", { name: "Mark done" }));
    await user.click(within(row("Finished")).getByRole("button", { name: "Mark done" }));
    expect(rowLabels()).toEqual([
      "Answer Asked first",
      "Approve Asks permission",
      "Check error Crashed",
      "Merge Approved",
    ]);
    expect(useUnreadStore.getState().prAcks).toEqual({ 6: "fix_ci:60:" });
  });

  it("doesn't flash while only an agent at work is being looked up", () => {
    useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {} });
    usePrStatusStore.setState({ byFeature: {} });
    useSessionStatusStore.setState({
      bySession: { 20: { featureId: 99, status: "agent", kind: null, seq: 1 } },
    });
    renderSection();
    expect(screen.queryByRole("region", { name: "For me" })).not.toBeInTheDocument();
  });

  it("stays hidden when switched off or while filtering", () => {
    configure({ forMe: false });
    const { unmount } = renderSection();
    expect(screen.queryByRole("region", { name: "For me" })).not.toBeInTheDocument();
    unmount();

    configure({});
    useSidebarFilterStore.getState().start("x", null);
    renderSection();
    expect(screen.queryByRole("region", { name: "For me" })).not.toBeInTheDocument();
  });
});

describe("SidebarForMeSection verbs", () => {
  it("names the request from its payload, else from the live status, else says Respond", () => {
    // The payload wins: a question the live status reports as a permission.
    useSessionStatusStore.setState({
      bySession: {
        10: { featureId: 1, status: "question", kind: null, seq: 8 },
        12: {
          featureId: 5,
          status: "question",
          kind: "permission",
          seq: 2,
          requestId: "request-5",
        },
      },
    });
    configure({ pendingRequest: false });
    const client = seededClient();
    client.removeQueries({ queryKey: ["/api/features", 1, "pending-gate"] });
    renderSection(client);
    expect(rowLabels().slice(0, 2)).toEqual(["Answer Asked first", "Respond Asks permission"]);
  });

  it("colors only the verbs that need an action", () => {
    configure({ forMeLimit: "all" });
    renderSection();
    const verb = (kind: string) =>
      section().querySelector(`[data-feature-next-action="${kind}"]`) as HTMLElement;
    expect(verb("failed")).toHaveClass("text-(--acc-red)");
    expect(verb("merge")).toHaveClass("text-foreground/75");
  });

  it("names the action on its own line, with the pull request it is about", () => {
    configure({ forMeLimit: "all" });
    renderSection();
    const line = (kind: string) =>
      section()
        .querySelector(`[data-feature-next-action="${kind}"]`)
        ?.closest("[data-feature-next-action-line]");
    expect(line("fix_ci")?.textContent).toMatch(/^Fix CI#\d+/);
    expect(line("failed")).toHaveAttribute("title", "The agent stopped on an error");
  });
});

describe("SidebarForMeSection blocks options", () => {
  it("keeps an empty block with its empty line when empty blocks are shown", () => {
    configure({ hideEmptyBlocks: false });
    useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {} });
    useSessionStatusStore.setState({ bySession: {} });
    usePrStatusStore.setState({ byFeature: {} });
    renderSection();
    expect(section()).toHaveTextContent("Nothing waiting on you");
  });

  it("swaps the count for a strong dot", () => {
    configure({ blockCounts: "dot" });
    renderSection();
    const header = screen.getByRole("button", { name: /For me/ });
    expect(header).not.toHaveTextContent(/\d/);
    expect(within(header).getByRole("img", { name: "6, 3 need an action" })).toHaveClass(
      "bg-amber-400",
    );
  });
});
