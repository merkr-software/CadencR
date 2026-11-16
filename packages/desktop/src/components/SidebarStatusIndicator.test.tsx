import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { PENDING_KIND_TEXT_CLASS } from "@/components/sidebar-pending-gate";
import { SidebarContext } from "./SidebarContext";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { SidebarSurfaceContext } from "@/stores/sidebar-surface-store";
import { SidebarStatusIndicator } from "./SidebarStatusIndicator";

const gate = vi.hoisted(() => ({
  kind: "permission" as "permission" | "question",
  payload: null as { tool_name: string } | null,
  setOpen: vi.fn(),
  usePopoverOpen: vi.fn(),
}));
const mobile = vi.hoisted(() => ({ value: false }));

vi.mock("@/stores/session-status-selectors", () => ({
  useFeatureStatus: () => ({ status: "question", kind: gate.kind }),
}));

const working = { state: "working", sourceFeatureId: 42 } as const;
const unread = { state: "unread", sourceFeatureId: 42 } as const;
const idle = { state: "idle", sourceFeatureId: 42 } as const;
const waiting = { state: "waiting", sourceFeatureId: 42 } as const;
vi.mock("@/hooks/usePendingGatePopoverOpen", () => ({
  usePendingGatePopoverOpen: gate.usePopoverOpen,
}));
vi.mock("@/hooks/useFeaturePendingGate", () => ({
  useFeaturePendingGate: () => ({
    isLoading: false,
    isSubmitting: false,
    gate: { request_id: "request-1", kind: gate.kind, payload: gate.payload },
  }),
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mobile.value }));
vi.mock("@/components/sidebar-gate/PendingGateBody", () => ({
  PendingGateBody: () => <div>Gate body</div>,
}));

describe("sidebar status", () => {
  beforeEach(() => {
    // No "For me" block here: the tree owns the gate popover's auto-open.
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, forMe: false } });
    gate.setOpen.mockClear();
    gate.payload = null;
    gate.kind = "permission";
    mobile.value = false;
    usePendingGatePopoverStore.setState({ open: null, planRequestIds: new Set() });
    gate.usePopoverOpen.mockReset().mockReturnValue({
      open: false,
      origin: null,
      requestKey: "request-1",
      onOpenChange: gate.setOpen,
      close: vi.fn(),
      hoverHandlers: undefined,
    });
  });

  it("prioritizes ongoing work over unread completion, then clears completion once read", () => {
    const props = { isActive: false, onOpenConversation: vi.fn() };
    const { rerender } = render(<SidebarStatusIndicator {...props} attention={working} />);
    expect(screen.getByRole("img", { name: "Agent working" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Unread agent messages" })).not.toBeInTheDocument();

    rerender(<SidebarStatusIndicator {...props} attention={unread} />);
    expect(screen.getByRole("img", { name: "Unread agent messages" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Agent working" })).not.toBeInTheDocument();

    rerender(<SidebarStatusIndicator {...props} attention={idle} />);
    expect(screen.getByRole("img", { name: "Agent idle" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Unread agent messages" })).not.toBeInTheDocument();
  });

  it.each([
    ["permission", PENDING_KIND_TEXT_CLASS.permission, "lucide-shield-alert"],
    ["question", PENDING_KIND_TEXT_CLASS.question, "lucide-message-circle-question-mark"],
  ] as const)(
    "keeps the %s indicator interactive without a provider logo",
    async (kind, color, icon) => {
      gate.kind = kind;
      const onNavigate = vi.fn();
      const { user } = render(
        <div onClick={onNavigate}>
          <SidebarStatusIndicator
            attention={waiting}
            isActive={false}
            onOpenConversation={onNavigate}
          />
        </div>,
      );
      const trigger = screen.getByRole("button", { name: `Pending ${kind}` });
      expect(trigger).toHaveClass(color);
      expect(trigger.querySelector("svg")).toHaveClass("sidebar-pending-indicator", icon);
      expect(gate.usePopoverOpen).toHaveBeenCalledWith(42, true, {
        isActive: false,
        gateReady: true,
      });
      expect(screen.queryByLabelText("Unread agent messages")).not.toBeInTheDocument();
      await user.click(trigger);
      expect(gate.setOpen).toHaveBeenCalledWith(true);
      expect(onNavigate).not.toHaveBeenCalled();
    },
  );

  it("suppresses automatic gate popovers for the active conversation", () => {
    render(<SidebarStatusIndicator attention={waiting} isActive onOpenConversation={vi.fn()} />);
    expect(gate.usePopoverOpen).toHaveBeenCalledWith(42, false, {
      isActive: true,
      gateReady: true,
    });
  });

  it("leaves a plan a plain icon that never opens, and records the request as a plan", async () => {
    gate.payload = { tool_name: "ExitPlanMode" };
    const onNavigate = vi.fn();
    const { user } = render(
      <div onClick={onNavigate}>
        <SidebarStatusIndicator attention={waiting} isActive={false} onOpenConversation={vi.fn()} />
      </div>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    const icon = screen.getByRole("img", { name: "Plan ready for review" });
    expect(gate.usePopoverOpen).not.toHaveBeenCalled();
    expect(usePendingGatePopoverStore.getState().planRequestIds.has("request-1")).toBe(true);
    // The click reaches the row, which opens the conversation as usual.
    await user.click(icon);
    expect(onNavigate).toHaveBeenCalled();
  });

  it('leaves a plain, non-interactive icon in the "off" mode', () => {
    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, forMe: false, gatePopover: "off" },
    });
    render(
      <SidebarStatusIndicator attention={waiting} isActive={false} onOpenConversation={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pending permission" })).toBeInTheDocument();
    expect(gate.usePopoverOpen).not.toHaveBeenCalled();
  });

  it("widens the icon's hit area without growing it, more on a phone", () => {
    const { rerender } = render(
      <SidebarStatusIndicator attention={waiting} isActive={false} onOpenConversation={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: "Pending permission" });
    expect(trigger).toHaveClass("size-3.5", "before:-inset-[5px]");
    mobile.value = true;
    rerender(
      <SidebarStatusIndicator attention={waiting} isActive={false} onOpenConversation={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Pending permission" })).toHaveClass(
      "before:-inset-[13px]",
    );
  });

  it("auto-opens on one surface only: For me over the tree, the rail when collapsed", () => {
    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, rail: "attention" },
    });
    const indicator = (
      <SidebarStatusIndicator attention={waiting} isActive={false} onOpenConversation={vi.fn()} />
    );
    const { rerender } = render(indicator);
    expect(gate.usePopoverOpen).toHaveBeenLastCalledWith(42, false, expect.anything());

    rerender(
      <SidebarSurfaceContext.Provider value="for-me">{indicator}</SidebarSurfaceContext.Provider>,
    );
    expect(gate.usePopoverOpen).toHaveBeenLastCalledWith(42, true, expect.anything());

    const collapsed = { collapsed: true, setCollapsed: vi.fn() };
    rerender(
      <SidebarContext.Provider value={collapsed}>
        <SidebarSurfaceContext.Provider value="for-me">{indicator}</SidebarSurfaceContext.Provider>
      </SidebarContext.Provider>,
    );
    expect(gate.usePopoverOpen).toHaveBeenLastCalledWith(42, false, expect.anything());
    rerender(
      <SidebarContext.Provider value={collapsed}>
        <SidebarSurfaceContext.Provider value="rail">{indicator}</SidebarSurfaceContext.Provider>
      </SidebarContext.Provider>,
    );
    expect(gate.usePopoverOpen).toHaveBeenLastCalledWith(42, true, expect.anything());
  });

  it("still flashes its row when the status style hides the slot", () => {
    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, forMe: false, status: "hidden" },
    });
    const props = { isActive: false, onOpenConversation: vi.fn() };
    const row = (attention: typeof working | typeof unread) => (
      <div data-nav-type="feature" data-testid="row">
        <SidebarStatusIndicator {...props} attention={attention} />
      </div>
    );
    const { rerender } = render(row(working));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    rerender(row(unread));
    expect(screen.getByTestId("row")).toHaveAttribute("data-sidebar-flash", "unread");
  });
});
