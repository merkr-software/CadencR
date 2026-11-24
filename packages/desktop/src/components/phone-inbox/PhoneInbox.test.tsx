import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@/test-utils";
import type { Feature, FeaturePendingGateResponse } from "@/api/generated";
import { SidebarAttentionContext } from "@/components/SidebarAttentionProvider";
import type { ResolvedAttentionResult } from "@/hooks/useResolvedAttention";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarSurfaceStore } from "@/stores/sidebar-surface-store";
import { CONVERSATION_VIEW_PREFETCH_TIMEOUT_MS, PhoneInbox } from "./PhoneInbox";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  navigateToConversation: vi.fn(),
  openQuickReply: vi.fn(),
  start: vi.fn(),
  preload: vi.fn(() => Promise.resolve()),
  prefetchAgentSession: vi.fn(() => Promise.resolve()),
  recent: { data: [] as unknown[], error: null as unknown, isPending: false },
  projects: { data: [] as unknown[], error: null as unknown, isPending: false },
  refetchProjects: vi.fn(() => Promise.resolve()),
  gates: {} as Record<number, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useMatch: () => undefined,
}));
vi.mock("@/lib/conversation-route", () => ({
  navigateToConversation: mocks.navigateToConversation,
}));
vi.mock("@/hooks/useOpenGateQuickReply", () => ({
  useOpenGateQuickReply: () => mocks.openQuickReply,
}));
vi.mock("@/hooks/useStartConversation", () => ({
  useStartConversation: () => ({ start: mocks.start, isPending: false }),
}));
vi.mock("@/lib/conversation-preload", () => ({ preloadConversation: mocks.preload }));
vi.mock("@/components/lazy/agent-session-chunk", () => ({
  prefetchAgentSession: mocks.prefetchAgentSession,
}));
vi.mock("@/components/SidebarRecentSection", () => ({
  useRecentFeatures: () => mocks.recent,
}));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListProjects: () => ({
    ...mocks.projects,
    isFetching: false,
    refetch: mocks.refetchProjects,
  }),
}));
vi.mock("@/hooks/useFeaturePendingGate", () => ({
  useFeaturePendingGate: ({ featureId }: { featureId: number }) => ({
    gate: mocks.gates[featureId],
    errorMessage: null,
  }),
}));
vi.mock("@/components/ProjectBadge", () => ({ ProjectBadge: () => null }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));
vi.mock("@/components/SidebarContext", () => ({
  useSidebarCollapsed: () => ({ collapsed: true, setCollapsed: vi.fn() }),
}));

function feature(id: number, title: string, projectId = 1): Feature {
  return {
    id,
    title,
    project_id: projectId,
    status: "active",
    created_at: "2026-11-24T08:00:00Z",
    last_activity_at: "2026-11-24T09:00:00Z",
  } as Feature;
}

function gate(kind: "permission" | "question" | "plan", text: string): FeaturePendingGateResponse {
  return {
    session_id: 1,
    request_id: `req-${kind}`,
    kind,
    payload:
      kind === "question"
        ? { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: text }] } }
        : { tool_name: "Bash", tool_input: { command: text }, description: text },
  } as FeaturePendingGateResponse;
}

const EMPTY: ResolvedAttentionResult = {
  entries: [],
  items: [],
  queue: [],
  byProject: new Map(),
  loadingStates: [],
  actions: [],
  actionsLoading: false,
};

function renderInbox(attention: Partial<ResolvedAttentionResult> = {}) {
  return render(
    <SidebarAttentionContext.Provider value={{ ...EMPTY, ...attention }}>
      <PhoneInbox />
    </SidebarAttentionContext.Provider>,
  );
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recent = { data: [], error: null, isPending: false };
  mocks.projects = {
    data: [
      { id: 1, name: "cadencr", path: "/repo/cadencr" },
      { id: 2, name: "web", path: "/repo/web" },
    ],
    error: null,
    isPending: false,
  };
  mocks.gates = {};
  act(() => {
    useSessionStatusStore.setState({ isConnected: true, hasSnapshot: true, bySession: {} });
    useSidebarSurfaceStore.setState({ forMeShowAll: false });
  });
});

describe("PhoneInbox sections", () => {
  it("lists For me (requests oldest first, other kinds newest first), In progress and Recent without repeats", () => {
    mocks.gates = { 1: gate("permission", "rm -rf build"), 2: gate("question", "Which port?") };
    const working = feature(3, "Busy agent", 2);
    mocks.recent.data = [feature(4, "Touched last"), working, feature(1, "Old ask")];
    renderInbox({
      actions: [
        { feature: feature(1, "Old ask"), kind: "waiting" },
        { feature: feature(2, "New ask"), kind: "waiting" },
        { feature: feature(5, "Read me"), kind: "review" },
      ],
      items: [{ feature: working, state: "working" }],
    });

    const forMe = within(section("For me")).getAllByRole("listitem");
    expect(forMe.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Old ask"),
      expect.stringContaining("New ask"),
      expect.stringContaining("Read me"),
    ]);
    expect(within(forMe[1]!).getByText("Which port?")).toBeInTheDocument();
    expect(within(forMe[1]!).getByRole("button", { name: /^Answer / })).toBeInTheDocument();
    expect(within(forMe[0]!).getByRole("button", { name: /^Approve / })).toBeInTheDocument();
    expect(within(forMe[2]!).getByRole("button", { name: /^Review / })).toBeInTheDocument();
    expect(within(forMe[0]!).getByText("cadencr")).toBeInTheDocument();

    const inProgress = within(section("In progress")).getAllByRole("listitem");
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]).toHaveTextContent("Busy agent");
    expect(inProgress[0]).toHaveTextContent("Working");
    expect(inProgress[0]).toHaveTextContent("web");

    const recent = within(section("Recent")).getAllByRole("listitem");
    expect(recent.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Touched last"),
    ]);
  });

  it("answers a question or a permission in the quick reply sheet, without navigating", async () => {
    mocks.gates = { 1: gate("permission", "rm -rf build"), 2: gate("question", "Which port?") };
    const { user } = renderInbox({
      actions: [
        { feature: feature(1, "Ask perm"), kind: "waiting" },
        { feature: feature(2, "Ask question"), kind: "waiting" },
      ],
    });
    await user.click(screen.getByRole("button", { name: /^Approve “Ask perm”/ }));
    await user.click(screen.getByRole("button", { name: /^Answer “Ask question”/ }));
    expect(mocks.openQuickReply.mock.calls).toEqual([[1], [2]]);
    expect(mocks.navigateToConversation).not.toHaveBeenCalled();
  });

  it("opens a plan and a reply to review in their conversation", async () => {
    mocks.gates = { 1: gate("plan", "The plan") };
    const { user } = renderInbox({
      actions: [
        { feature: feature(1, "Planner"), kind: "waiting" },
        { feature: feature(2, "Done", 2), kind: "review" },
      ],
    });
    await user.click(screen.getByRole("button", { name: /^Approve “Planner”/ }));
    await user.click(screen.getByRole("button", { name: /^Review “Done”/ }));
    expect(mocks.openQuickReply).not.toHaveBeenCalled();
    expect(mocks.navigateToConversation.mock.calls).toEqual([
      [mocks.navigate, 1, 1, { cwd: "/repo/cadencr", featureKnown: true }],
      [mocks.navigate, 2, 2, { cwd: "/repo/web", featureKnown: true }],
    ]);
  });

  it("opens the conversation from a card's body, preloading it on press", async () => {
    mocks.recent.data = [feature(7, "Recent one", 2)];
    const { user } = renderInbox();
    await user.click(screen.getByText("Recent one"));
    expect(mocks.preload).toHaveBeenCalledWith(7, expect.any(Number));
    expect(mocks.prefetchAgentSession).toHaveBeenCalled();
    expect(mocks.navigateToConversation).toHaveBeenCalledWith(mocks.navigate, 2, 7, {
      cwd: "/repo/web",
      featureKnown: true,
    });
  });
});

describe("PhoneInbox states", () => {
  it("holds For me and In progress on skeletons until the first status snapshot", () => {
    act(() => useSessionStatusStore.setState({ isConnected: true, hasSnapshot: false }));
    mocks.recent.isPending = true;
    renderInbox();
    expect(screen.getByLabelText("Loading For me")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading In progress")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading Recent")).toBeInTheDocument();
  });

  it("says when a section is empty", () => {
    mocks.recent.data = [feature(7, "Recent one")];
    renderInbox();
    expect(screen.getByText("Nothing waiting on you")).toBeInTheDocument();
    expect(screen.getByText("No agent at work")).toBeInTheDocument();
  });

  it("shows Recent's error in its section", () => {
    mocks.recent.error = new Error("Service down");
    renderInbox();
    expect(within(section("Recent")).getByRole("alert")).toHaveTextContent("Service down");
  });

  it("offers New conversation in a project sheet when everything is empty", async () => {
    const { user } = renderInbox();
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "New conversation" });
    await user.click(buttons[buttons.length - 1]!);
    await user.click(await screen.findByRole("button", { name: "web" }));
    expect(mocks.start).toHaveBeenCalledWith(2);
  });

  it("starts in the only project straight away", async () => {
    mocks.projects.data = [{ id: 1, name: "cadencr", path: "/repo/cadencr" }];
    const { user } = renderInbox();
    await user.click(screen.getAllByRole("button", { name: "New conversation" })[0]!);
    expect(mocks.start).toHaveBeenCalledWith(1);
  });

  it("holds every section on skeletons until the projects are known", () => {
    mocks.projects = { data: [], error: null, isPending: true };
    mocks.recent.data = [feature(7, "Recent one")];
    renderInbox({ actions: [{ feature: feature(5, "Read me"), kind: "review" }] });
    expect(screen.getByLabelText("Loading For me")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading In progress")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading Recent")).toBeInTheDocument();
    expect(screen.queryByText("Read me")).toBeNull();
    expect(screen.queryByText("No projects yet")).toBeNull();
  });

  it("shows a projects error above the sections, with Retry", async () => {
    mocks.projects = { data: [], error: new Error("Service down"), isPending: false };
    mocks.recent.data = [feature(7, "Recent one")];
    const { user } = renderInbox();
    expect(screen.getByRole("alert")).toHaveTextContent("Service down");
    expect(within(section("Recent")).getByText("Recent one")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetchProjects).toHaveBeenCalledTimes(1);
  });

  it("caps For me like the sidebar block, the rest behind Show more", async () => {
    const actions = [1, 2, 3, 4, 5].map((id) => ({
      feature: feature(id, `Done ${id}`),
      kind: "review" as const,
    }));
    const { user } = renderInbox({ actions });
    expect(within(section("For me")).getAllByRole("listitem")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(within(section("For me")).getAllByRole("listitem")).toHaveLength(5);
  });

  it("points at the menu when there is no project", () => {
    mocks.projects.data = [];
    renderInbox();
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
  });

  it("names the page and keeps the menu button free of the attention count", () => {
    mocks.gates = { 1: gate("question", "Which port?") };
    renderInbox({ actions: [{ feature: feature(1, "Ask"), kind: "waiting" }] });
    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
  });
});

describe("PhoneInbox conversation view prefetch", () => {
  afterEach(() => vi.useRealTimers());

  it("fetches the conversation view once the cards are up and the page is idle", () => {
    vi.useFakeTimers();
    mocks.projects.isPending = true;
    const { rerender } = renderInbox();
    act(() => vi.advanceTimersByTime(CONVERSATION_VIEW_PREFETCH_TIMEOUT_MS));
    expect(mocks.prefetchAgentSession).not.toHaveBeenCalled();

    mocks.projects.isPending = false;
    rerender(
      <SidebarAttentionContext.Provider value={EMPTY}>
        <PhoneInbox />
      </SidebarAttentionContext.Provider>,
    );
    expect(mocks.prefetchAgentSession).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CONVERSATION_VIEW_PREFETCH_TIMEOUT_MS));
    expect(mocks.prefetchAgentSession).toHaveBeenCalledTimes(1);
  });
});
