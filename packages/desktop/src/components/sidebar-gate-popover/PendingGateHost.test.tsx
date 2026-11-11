// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "@/api/generated";
import { SidebarAttentionContext } from "@/components/SidebarAttentionProvider";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { act, render, screen, waitFor } from "@/test-utils";
import { PendingGateHost } from "./PendingGateHost";

const mocks = vi.hoisted(() => ({
  shortcut: null as null | ((event: KeyboardEvent) => void),
  navigate: vi.fn(),
  toast: vi.fn(),
  mobile: false,
  planFeatureIds: new Set<number>(),
}));

vi.mock("sonner", () => ({ toast: { message: mocks.toast, error: vi.fn() } }));
vi.mock("@/hooks/useShortcut", () => ({
  useGlobalShortcutById: (id: string, callback: (event: KeyboardEvent) => void) => {
    if (id === "answer-newest-request") mocks.shortcut = callback;
  },
}));
vi.mock("@/hooks/useCrossProjectNavigate", () => ({
  useCrossProjectNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/useFeaturePendingGate", () => ({
  useFeaturePendingGate: ({ featureId }: { featureId: number }) => ({
    isLoading: false,
    isSubmitting: false,
    gate: {
      request_id: `r${featureId}`,
      kind: mocks.planFeatureIds.has(featureId) ? "plan" : "permission",
      payload: {},
    },
  }),
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("@/hooks/useOwnsGateAutoOpen", () => ({ useGateAutoOpenOwner: () => "for-me" }));
vi.mock("@/hooks/useSidebarSettings", () => ({ useSetSidebarOption: () => vi.fn() }));
vi.mock("@/components/sidebar-gate/PendingGateBody", () => ({
  PendingGateBody: ({ featureId, touch }: { featureId: number; touch?: boolean }) => (
    <div data-testid="gate-body">{`body ${featureId}${touch ? " touch" : ""}`}</div>
  ),
}));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListProjects: () => ({ data: [{ id: 5, name: "web-app" }] }),
}));

const feature = (id: number, title: string) => ({ id, project_id: 5, title }) as Feature;
const attention = {
  entries: [],
  items: [],
  queue: [],
  byProject: new Map(),
  loadingStates: [],
  actions: [
    { feature: feature(1, "Fix login"), kind: "waiting" as const },
    { feature: feature(2, "Add billing"), kind: "waiting" as const },
    { feature: feature(3, "Plan the migration"), kind: "waiting" as const },
  ],
  actionsLoading: false,
};

const entry = (featureId: number, seq: number, requestId: string) =>
  ({ status: "question", kind: "permission", requestId, featureId, seq }) as const;

function host() {
  return (
    <SidebarAttentionContext.Provider value={attention}>
      <PendingGateHost activeFeatureId={null} onSelectFeature={vi.fn()} />
    </SidebarAttentionContext.Provider>
  );
}

function pressShortcut(): void {
  act(() => mocks.shortcut?.(new KeyboardEvent("keydown")));
}

beforeEach(() => {
  mocks.shortcut = null;
  mocks.mobile = false;
  mocks.planFeatureIds = new Set();
  mocks.navigate.mockReset();
  mocks.toast.mockReset();
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
  usePendingGatePopoverStore.setState({
    open: null,
    dismissedRequestIds: new Set(),
    planRequestIds: new Set(),
  });
  useSessionStatusStore.setState({
    bySession: { 11: entry(1, 1, "r1"), 12: entry(2, 2, "r2"), 13: entry(3, 3, "r3") },
  });
});

describe("PendingGateHost bottom sheet", () => {
  it("shows the header and the body in a sheet, and closes remembering the request", async () => {
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 1, surface: "sheet", origin: "user" });
    const { user } = render(host());
    expect(await screen.findByText("Fix login")).toBeInTheDocument();
    expect(screen.getByTestId("gate-body")).toHaveTextContent("body 1 touch");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(usePendingGatePopoverStore.getState().open).toBeNull();
    expect(usePendingGatePopoverStore.getState().dismissedRequestIds.has("r1")).toBe(true);
  });

  it("opens the conversation from the sheet", async () => {
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 2, surface: "sheet", origin: "user" });
    const { user } = render(host());
    await user.click(await screen.findByRole("button", { name: "Open conversation" }));
    expect(mocks.navigate).toHaveBeenCalledWith(attention.actions[1]?.feature);
    expect(usePendingGatePopoverStore.getState().open).toBeNull();
  });

  it("steps through the queue with its arrows", async () => {
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 1, surface: "sheet", origin: "user" });
    mocks.mobile = true;
    const { user } = render(host());
    expect(await screen.findByText("1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next request" }));
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({
      featureId: 2,
      surface: "sheet",
    });
    expect(await screen.findByText("2 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous request" }));
    expect(usePendingGatePopoverStore.getState().open?.featureId).toBe(1);
  });

  it("leaves plans out of the queue", async () => {
    usePendingGatePopoverStore.getState().markPlanRequest("r3", true);
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 1, surface: "sheet", origin: "user" });
    render(host());
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  });
});

describe("PendingGateHost bottom sheet on a plan", () => {
  it("never shows a plan: it closes, remembering it as a plan without dismissing it", async () => {
    mocks.planFeatureIds = new Set([3]);
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 3, surface: "sheet", origin: "auto" });
    render(host());
    await waitFor(() => expect(usePendingGatePopoverStore.getState().open).toBeNull());
    expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument();
    const state = usePendingGatePopoverStore.getState();
    expect(state.planRequestIds.has("r3")).toBe(true);
    expect(state.dismissedRequestIds.has("r3")).toBe(false);
  });
});

describe("Answer newest request shortcut", () => {
  it("opens the newest request as the user's own, on a phone's sheet", () => {
    mocks.mobile = true;
    render(host());
    pressShortcut();
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({
      featureId: 3,
      surface: "sheet",
      origin: "user",
    });
  });

  it("skips a newer plan", () => {
    usePendingGatePopoverStore.getState().markPlanRequest("r3", true);
    mocks.mobile = true;
    render(host());
    pressShortcut();
    expect(usePendingGatePopoverStore.getState().open?.featureId).toBe(2);
  });

  it("opens nothing visible for a plan whose row is not mounted", async () => {
    mocks.planFeatureIds = new Set([3]);
    mocks.mobile = true;
    render(host());
    pressShortcut();
    await waitFor(() => expect(usePendingGatePopoverStore.getState().open).toBeNull());
    expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument();
  });

  it("falls back to the sheet when no row shows the request on desktop", () => {
    render(host());
    pressShortcut();
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({ surface: "sheet" });
  });

  it("says so when nothing waits, or when the quick reply is off", () => {
    useSessionStatusStore.setState({ bySession: {} });
    render(host());
    pressShortcut();
    expect(mocks.toast).toHaveBeenCalledWith("No request to answer here");

    act(() =>
      useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "off" } }),
    );
    pressShortcut();
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.stringContaining("Quick reply is off"));
    expect(usePendingGatePopoverStore.getState().open).toBeNull();
  });
});
