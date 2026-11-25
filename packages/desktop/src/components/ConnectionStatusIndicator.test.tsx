import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatusIndicator";
import { uiI18n } from "@/lib/i18n/ui";
import {
  reportManualReconnectRequired,
  useConnectionStatusStore,
} from "@/stores/connection-status-store";

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

  it("retranslates an open popover, preserving focus and connection state", async () => {
    const { user } = render(<ConnectionStatusIndicator />);
    act(() => {
      reportManualReconnectRequired("app");
      useConnectionStatusStore.setState({ lastConnectedAt: Date.now() - 120_000 });
    });
    const trigger = screen.getByRole("button", { name: /Backend Reconnect paused/ });
    await user.click(trigger);
    const retry = screen.getByRole("button", { name: "Retry now" });
    retry.focus();
    expect(screen.getByText("Last connected 2 min ago")).toBeVisible();
    uiI18n.addResourceBundle("fr", "ui", {
      conversation: {
        connection: {
          lastConnected: "Dernière connexion {{age}}",
          paused: "Reconnexion au service suspendue",
          reconnectPaused: "En pause",
          reconnectTimeout_other: "Délai de {{count, number}} secondes écoulé",
          retryNow: "Réessayer",
          statusWithReason: "Service {{status}} — {{reason}}",
        },
      },
      time: { relative: { minutesAgo: "il y a {{number}} min" } },
    });
    try {
      await act(() => uiI18n.changeLanguage("fr"));
      expect(screen.getByRole("button", { name: /Service En pause — Délai de/ })).toBe(trigger);
      expect(screen.getByText("Dernière connexion il y a 2 min")).toBeVisible();
      expect(screen.getByRole("button", { name: "Réessayer" })).toBe(retry);
      expect(retry).toHaveFocus();
      expect(useConnectionStatusStore.getState().status).toBe("manual_reconnect_required");

      await act(() => uiI18n.changeLanguage("en"));
      expect(screen.getByRole("button", { name: "Retry now" })).toBe(retry);
      expect(screen.getByText("Last connected 2 min ago")).toBeVisible();
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });
});
