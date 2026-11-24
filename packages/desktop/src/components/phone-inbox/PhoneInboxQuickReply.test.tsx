import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test-utils";
import type { Feature, FeatureGateDecision, FeaturePendingGateResponse } from "@/api/generated";
import { SidebarAttentionContext } from "@/components/SidebarAttentionProvider";
import { GatePopoverSheet } from "@/components/sidebar-gate-popover/GatePopoverSheet";
import type { ResolvedAttentionResult } from "@/hooks/useResolvedAttention";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { PhoneInbox } from "./PhoneInbox";

/**
 * The inbox's answer path end to end, with the request and its answer mocked:
 * "Approve" opens the real quick reply sheet, whose action answers the request.
 */
const mocks = vi.hoisted(() => ({
  respond: vi.fn<(decision: FeatureGateDecision) => void>(),
  navigateToConversation: vi.fn(),
  gates: {} as Record<number, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useMatch: () => undefined,
  // The inbox's home route: no conversation open.
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/", search: {} } }),
}));
vi.mock("@/lib/conversation-route", () => ({
  navigateToConversation: mocks.navigateToConversation,
}));
vi.mock("@/hooks/useStartConversation", () => ({
  useStartConversation: () => ({ start: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/conversation-preload", () => ({ preloadConversation: vi.fn() }));
vi.mock("@/components/SidebarRecentSection", () => ({
  useRecentFeatures: () => ({ data: [], error: null, isPending: false }),
}));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListProjects: () => ({
    data: [{ id: 1, name: "cadencr", path: "/repo" }],
    error: null,
    isPending: false,
  }),
}));
vi.mock("@/hooks/useFeaturePendingGate", () => ({
  useFeaturePendingGate: ({ featureId }: { featureId: number }) => ({
    gate: mocks.gates[featureId] ?? null,
    isLoading: false,
    isError: false,
    errorMessage: null,
    isSubmitting: false,
    respond: mocks.respond,
  }),
}));
vi.mock("@/components/ProjectBadge", () => ({ ProjectBadge: () => null }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));
vi.mock("@/components/SidebarContext", () => ({
  useSidebarCollapsed: () => ({ collapsed: true, setCollapsed: vi.fn() }),
}));

const FEATURE = {
  id: 4,
  title: "Stamp the build",
  project_id: 1,
  status: "active",
  created_at: "2026-11-24T08:00:00Z",
} as Feature;

const ATTENTION: ResolvedAttentionResult = {
  entries: [{ featureId: 4, state: "waiting" }],
  items: [{ feature: FEATURE, state: "waiting" }],
  queue: [{ feature: FEATURE, state: "waiting" }],
  byProject: new Map(),
  loadingStates: [],
  actions: [{ feature: FEATURE, kind: "waiting" }],
  actionsLoading: false,
};

function permission(): FeaturePendingGateResponse {
  return {
    session_id: 40,
    request_id: "req-1",
    kind: "permission",
    payload: {
      tool_name: "Bash",
      tool_input: { command: "mkdir out" },
      options: [
        { decision: "allow_once", label: "Allow once" },
        { decision: "deny", label: "Deny" },
      ],
    },
  } as FeaturePendingGateResponse;
}

function renderInboxWithSheet(attention: ResolvedAttentionResult = ATTENTION) {
  const openConversation = vi.fn();
  const view = render(
    <SidebarAttentionContext.Provider value={attention}>
      <PhoneInbox />
      <GatePopoverSheet onOpenConversation={openConversation} />
    </SidebarAttentionContext.Provider>,
  );
  return { ...view, openConversation };
}

const QUESTION_FEATURE = { ...FEATURE, id: 5, title: "Add CSV export" } as Feature;

/** Two requests, in the sidebar's order (oldest first): the quick reply's queue. */
const TWO_WAITING: ResolvedAttentionResult = {
  ...ATTENTION,
  entries: [
    { featureId: 4, state: "waiting" },
    { featureId: 5, state: "waiting" },
  ],
  items: [
    { feature: FEATURE, state: "waiting" },
    { feature: QUESTION_FEATURE, state: "waiting" },
  ],
  queue: [
    { feature: FEATURE, state: "waiting" },
    { feature: QUESTION_FEATURE, state: "waiting" },
  ],
  actions: [
    { feature: FEATURE, kind: "waiting" },
    { feature: QUESTION_FEATURE, kind: "waiting" },
  ],
};

function question(): FeaturePendingGateResponse {
  return {
    session_id: 50,
    request_id: "req-2",
    kind: "question",
    payload: {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which delimiter?",
            options: [
              { label: "Comma", description: "RFC 4180" },
              { label: "Tab", description: "TSV" },
            ],
          },
        ],
      },
    },
  } as FeaturePendingGateResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gates = { 4: permission(), 5: question() };
  act(() => {
    usePendingGatePopoverStore.setState({ open: null });
    useSessionStatusStore.setState({
      isConnected: true,
      hasSnapshot: true,
      bySession: {
        40: { status: "question", kind: "permission", requestId: "req-1", featureId: 4, seq: 1 },
        50: { status: "question", kind: "question", requestId: "req-2", featureId: 5, seq: 1 },
      },
    });
  });
});

describe("PhoneInbox quick reply", () => {
  it("opens the phone sheet from For me and answers the request there", async () => {
    const { user } = renderInboxWithSheet();
    await user.click(screen.getByRole("button", { name: /^Approve “Stamp the build”/ }));
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({
      featureId: 4,
      surface: "sheet",
      origin: "user",
    });
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /Allow once/ }));
    expect(mocks.respond).toHaveBeenCalledWith({ type: "permission", action: "allow_once" });
    expect(mocks.navigateToConversation).not.toHaveBeenCalled();
  });

  it("closes the sheet without answering", async () => {
    const { user } = renderInboxWithSheet();
    await user.click(screen.getByRole("button", { name: /^Approve “Stamp the build”/ }));
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.respond).not.toHaveBeenCalled();
  });
});

/**
 * The order iOS Safari dispatches a tap in: pointer and touch events first, then
 * the compatibility mouse events and the click, hit-tested only after the touch
 * handlers ran. Anything a press changes under the finger (a sheet opening on
 * pointerdown, a card moving) would take the click.
 */
function iosTap(button: HTMLElement, buttonNow: () => HTMLElement): void {
  fireEvent.pointerDown(button, { pointerType: "touch", isPrimary: true });
  fireEvent.touchStart(button);
  fireEvent.pointerUp(button, { pointerType: "touch", isPrimary: true });
  fireEvent.touchEnd(button);
  // Nothing opened or moved yet: the click lands on the same button.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(usePendingGatePopoverStore.getState().open).toBeNull();
  const target = buttonNow();
  expect(target).toBe(button);
  fireEvent.mouseOver(target);
  fireEvent.mouseDown(target);
  fireEvent.mouseUp(target);
  fireEvent.click(target);
}

describe("PhoneInbox quick reply, two requests", () => {
  it.each([
    ["Answer", "Add CSV export", 5],
    ["Approve", "Stamp the build", 4],
  ])(
    "a tap on %s “%s” opens that request's sheet, in iOS's event order, and navigates nowhere",
    async (verb, title, featureId) => {
      const { openConversation } = renderInboxWithSheet(TWO_WAITING);
      const name = new RegExp(`^${verb} “${title}”`);
      iosTap(screen.getByRole("button", { name }), () => screen.getByRole("button", { name }));
      expect(usePendingGatePopoverStore.getState().open).toMatchObject({
        featureId,
        surface: "sheet",
        origin: "user",
      });
      const sheet = await screen.findByRole("dialog");
      expect(within(sheet).getByText(title)).toBeInTheDocument();
      expect(mocks.navigateToConversation).not.toHaveBeenCalled();
      expect(openConversation).not.toHaveBeenCalled();
      expect(mocks.respond).not.toHaveBeenCalled();
    },
  );

  it("numbers the sheet from the top card and moves on to the card below it", async () => {
    const { user } = renderInboxWithSheet(TWO_WAITING);
    const cards = within(screen.getByRole("region", { name: "For me" })).getAllByRole("listitem");
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Stamp the build"),
      expect.stringContaining("Add CSV export"),
    ]);
    await user.click(within(cards[0]!).getByRole("button", { name: /^Approve / }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("1 of 2")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Next request" }));
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({ featureId: 5 });
    expect(within(await screen.findByRole("dialog")).getByText("2 of 2")).toBeInTheDocument();
    expect(mocks.navigateToConversation).not.toHaveBeenCalled();
  });
});
