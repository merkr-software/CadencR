import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatusIndicator";
import { useConnectionStatusStore } from "@/stores/connection-status-store";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

const originalForceReconnectAll = useConnectionStatusStore.getState().forceReconnectAll;

describe("ConnectionStatusIndicator", () => {
  beforeEach(() => {
    useConnectionStatusStore.setState({
      status: "connected",
      reason: null,
      lastConnectedAt: null,
      sources: {},
      forceReconnectAll: originalForceReconnectAll,
    });
    vi.clearAllMocks();
  });

  it("shows a paused reconnect state when automatic retries hit the cap", () => {
    useConnectionStatusStore.setState({
      status: "manual_reconnect_required",
      reason: "Backend WebSocket failed to reconnect for 240 seconds",
      lastConnectedAt: null,
    });

    render(<ConnectionStatusIndicator />);

    expect(screen.getByRole("button", { name: /Backend Reconnect paused/ })).toBeInTheDocument();
    expect(screen.getByText("Reconnect paused")).toBeInTheDocument();
  });

  it("manual retry button calls the manual reconnect path", async () => {
    const forceReconnectAll = vi.fn();
    useConnectionStatusStore.setState({
      status: "manual_reconnect_required",
      reason: "Backend WebSocket failed to reconnect for 240 seconds",
      lastConnectedAt: null,
      forceReconnectAll,
    });
    const { user } = render(<ConnectionStatusIndicator />);

    await user.click(screen.getByRole("button", { name: /Backend Reconnect paused/ }));
    await user.click(screen.getByRole("button", { name: "Retry now" }));

    expect(forceReconnectAll).toHaveBeenCalledWith({ bypassManualPause: true });
  });
});
