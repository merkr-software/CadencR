// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "@/api/generated";
import { SidebarAttentionContext } from "@/components/SidebarAttentionProvider";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { act, render, screen, waitFor } from "@/test-utils";
import { SidebarPendingGatePopover } from "./SidebarPendingGatePopover";

const mocks = vi.hoisted(() => ({ setOption: vi.fn(), mobile: false }));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("@/hooks/useSidebarSettings", () => ({ useSetSidebarOption: () => mocks.setOption }));
vi.mock("@/hooks/useFeaturePendingGate", () => ({
  useFeaturePendingGate: () => ({
    isLoading: false,
    isSubmitting: false,
    gate: { request_id: "request-1", kind: "permission", payload: {} },
  }),
}));
vi.mock("@/components/sidebar-gate/PendingGateBody", async () => {
  const { useState } = await import("react");
  const { DenyFeedback } = await import("@/components/sidebar-gate/DenyFeedback");
  function MockBody({ autoFocus }: { autoFocus: boolean }) {
    const [denying, setDenying] = useState(false);
    return (
      <div data-testid="gate-body" data-autofocus={String(autoFocus)}>
        <button type="button">Allow once</button>
        {denying ? (
          <DenyFeedback
            isSubmitting={false}
            touch={false}
            onSubmit={() => {}}
            onCancel={() => setDenying(false)}
          />
        ) : (
          <button type="button" onClick={() => setDenying(true)}>
            Deny
          </button>
        )}
      </div>
    );
  }
  return { PendingGateBody: MockBody };
});
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListProjects: () => ({ data: [{ id: 5, name: "web-app" }] }),
}));

const FEATURE_ID = 42;
const attention = {
  entries: [],
  items: [],
  queue: [],
  byProject: new Map(),
  loadingStates: [],
  actions: [
    { feature: { id: FEATURE_ID, project_id: 5, title: "Fix login" } as Feature, kind: "waiting" },
  ],
  actionsLoading: false,
} as const;

function row(
  props: { isActive?: boolean; onOpenConversation?: () => void; onKeyDown?: () => void } = {},
) {
  return (
    // Stands for the sidebar, which React's portal bubbling reaches.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div onKeyDown={props.onKeyDown}>
      <SidebarAttentionContext.Provider value={attention}>
        <input aria-label="Composer" />
        <SidebarPendingGatePopover
          featureId={FEATURE_ID}
          allowAutoOpen
          isActive={props.isActive ?? false}
          onOpenConversation={props.onOpenConversation ?? vi.fn()}
        />
      </SidebarAttentionContext.Provider>
    </div>
  );
}

beforeEach(() => {
  mocks.mobile = false;
  mocks.setOption.mockReset();
  usePendingGatePopoverStore.setState({
    open: null,
    dismissedRequestIds: new Set(),
    planRequestIds: new Set(),
  });
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
  useSessionStatusStore.setState({
    bySession: {
      1: {
        status: "question",
        kind: "permission",
        requestId: "request-1",
        featureId: FEATURE_ID,
        seq: 1,
      },
    },
  });
});

describe("SidebarPendingGatePopover", () => {
  it("opens by itself with a header naming the conversation and its project", async () => {
    render(row());
    expect(await screen.findByText("Fix login")).toBeInTheDocument();
    expect(screen.getByText(/web-app/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    // An automatic popover never takes focus.
    expect(screen.getByTestId("gate-body")).toHaveAttribute("data-autofocus", "false");
  });

  it("survives focus moving outside, and a click outside, while automatic", async () => {
    const { user } = render(row());
    await screen.findByTestId("gate-body");
    await user.click(screen.getByLabelText("Composer"));
    expect(screen.getByLabelText("Composer")).toHaveFocus();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("gate-body")).toBeInTheDocument();
    expect(usePendingGatePopoverStore.getState().open?.origin).toBe("auto");
  });

  it("closes on X and remembers the request, so a remount doesn't reopen it", async () => {
    const { user, unmount } = render(row());
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument());
    expect(usePendingGatePopoverStore.getState().dismissedRequestIds.has("request-1")).toBe(true);
    unmount();

    render(row());
    expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument();
  });

  it("closes on Escape pressed inside", async () => {
    const { user } = render(row());
    await screen.findByTestId("gate-body");
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument());
  });

  it("closes an automatic card on Escape from elsewhere, and lets the next Escape through", async () => {
    const { user } = render(row());
    await screen.findByTestId("gate-body");
    await user.click(screen.getByLabelText("Composer"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument());

    // The card is gone: the next Escape reaches the app (the composer's Stop) untouched.
    let prevented: boolean | null = null;
    const listen = (event: KeyboardEvent): void => {
      prevented = event.defaultPrevented;
    };
    document.addEventListener("keydown", listen);
    await user.keyboard("{Escape}");
    document.removeEventListener("keydown", listen);
    expect(prevented).toBe(false);
  });

  it("cancels only the deny field on Escape, then closes on the next one", async () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "click" } });
    const { user } = render(row());
    await user.click(screen.getByRole("button", { name: "Pending permission" }));
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    const field = screen.getByLabelText("Tell the agent what to do instead");
    expect(field).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Tell the agent what to do instead")).not.toBeInTheDocument();
    expect(screen.getByTestId("gate-body")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument());
  });

  it("returns focus to the icon once a popover the user opened closes", async () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "click" } });
    const { user } = render(row());
    const trigger = screen.getByRole("button", { name: "Pending permission" });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Allow once" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("takes over a hovered popover on a click on its icon instead of closing it", async () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "hover" } });
    const { user } = render(row());
    act(() =>
      usePendingGatePopoverStore
        .getState()
        .openGate({ featureId: FEATURE_ID, surface: "tree", origin: "hover" }),
    );
    await screen.findByTestId("gate-body");
    await user.click(screen.getByRole("button", { name: "Pending permission" }));
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({ origin: "user" });
    expect(usePendingGatePopoverStore.getState().dismissedRequestIds.size).toBe(0);
  });

  it("keeps typed keys from the sidebar's type-to-filter, but not shortcuts", async () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "click" } });
    const onKeyDown = vi.fn();
    const { user } = render(row({ onKeyDown }));
    await user.click(screen.getByRole("button", { name: "Pending permission" }));
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    onKeyDown.mockClear();
    await user.keyboard("a");
    expect(onKeyDown).not.toHaveBeenCalled();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(onKeyDown).toHaveBeenCalled();
  });

  it("opens on hover without taking focus", async () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "hover" } });
    const { user } = render(row());
    await user.hover(screen.getByRole("button", { name: "Pending permission" }));
    expect(await screen.findByTestId("gate-body")).toHaveAttribute("data-autofocus", "false");
    expect(usePendingGatePopoverStore.getState().open?.origin).toBe("hover");
  });

  it("opens the conversation from the header and closes", async () => {
    const onOpen = vi.fn();
    const { user } = render(row({ onOpenConversation: onOpen }));
    await user.click(await screen.findByRole("button", { name: "Open conversation" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(usePendingGatePopoverStore.getState().open).toBeNull();
  });

  it("opens on a click as the user's own (focus goes inside) and closes on an outside click", async () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "click" } });
    const { user } = render(row());
    expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pending permission" }));
    expect(await screen.findByTestId("gate-body")).toHaveAttribute("data-autofocus", "true");

    await user.click(document.body);
    await waitFor(() => expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument());
  });

  it("stops opening by itself from its footer, switching the option to click", async () => {
    const { user } = render(row());
    await user.click(await screen.findByRole("button", { name: "Don't open automatically" }));
    expect(mocks.setOption).toHaveBeenCalledWith("gatePopover", "click");
    await waitFor(() => expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument());
  });

  it("offers that footer in auto mode only", async () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "click" } });
    const { user } = render(row());
    await user.click(screen.getByRole("button", { name: "Pending permission" }));
    await screen.findByTestId("gate-body");
    expect(screen.queryByRole("button", { name: "Don't open automatically" })).toBeNull();
  });

  it("opens the bottom sheet's state, not a popover, when tapped on a phone", async () => {
    mocks.mobile = true;
    const { user } = render(row());
    await user.click(screen.getByRole("button", { name: "Pending permission" }));
    expect(screen.queryByTestId("gate-body")).not.toBeInTheDocument();
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({
      featureId: FEATURE_ID,
      surface: "sheet",
      origin: "user",
    });
  });
});
