import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import {
  resetServiceStatusToastForTests,
  serviceDownSummary,
  showServiceStatus,
} from "./service-status-toast";

type ToastOptions = Parameters<typeof toast.error>[1];

function actionOf(options: ToastOptions): (event: { preventDefault: () => void }) => void {
  const action = options?.action;
  if (!action || typeof action !== "object" || !("onClick" in action)) {
    throw new Error("expected a toast action");
  }
  return action.onClick as never;
}

beforeEach(() => resetServiceStatusToastForTests());
afterEach(() => {
  clearDesktopBridgeOverrideForTests();
  vi.restoreAllMocks();
});

describe("serviceDownSummary", () => {
  it("keeps the exit line and the service's last log line", () => {
    expect(
      serviceDownSummary(
        "Service exit: code=101 signal=null.\nLast log lines:\nstarting\nthread panicked at db.rs",
      ),
    ).toBe("Service exit: code=101 signal=null. thread panicked at db.rs");
  });

  it("falls back to a plain sentence when nothing was said", () => {
    expect(serviceDownSummary("")).toBe("The service stopped unexpectedly.");
  });
});

describe("showServiceStatus", () => {
  it("offers a restart that keeps its own toast alive", () => {
    const restartService = vi.fn(() => Promise.resolve());
    setDesktopBridgeOverrideForTests({ restartService });
    const error = vi.spyOn(toast, "error");

    showServiceStatus({ state: "down", detail: "Service exit: code=1 signal=null." });

    const [, options] = error.mock.calls[0];
    expect(options).toEqual(
      expect.objectContaining({ id: "service-status", duration: Number.POSITIVE_INFINITY }),
    );
    const preventDefault = vi.fn();
    actionOf(options)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(restartService).toHaveBeenCalledTimes(1);
  });

  it("shows the restart under the same id without the Restart action", () => {
    const loading = vi.spyOn(toast, "loading");

    showServiceStatus({ state: "restarting" });

    expect(loading).toHaveBeenCalledWith("Restarting Cadencr's service…", {
      id: "service-status",
      description: undefined,
      action: undefined,
      cancel: undefined,
      duration: undefined,
    });
  });

  it("announces recovery only after an outage", () => {
    const success = vi.spyOn(toast, "success");

    showServiceStatus({ state: "running" });
    expect(success).not.toHaveBeenCalled();

    showServiceStatus({ state: "restarting" });
    showServiceStatus({ state: "running" });
    expect(success).toHaveBeenCalledWith(
      "Cadencr's service is running again",
      expect.objectContaining({ id: "service-status", action: undefined }),
    );
  });

  it("reports a restart main refused", async () => {
    setDesktopBridgeOverrideForTests({
      restartService: () => Promise.reject(new Error("Cadencr is shutting down.")),
    });
    const error = vi.spyOn(toast, "error");
    showServiceStatus({ state: "down", detail: "Service exit: code=1 signal=null." });

    actionOf(error.mock.calls[0][1])({ preventDefault: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(error).toHaveBeenLastCalledWith(
      "Cadencr's service stopped",
      expect.objectContaining({
        description: "Cadencr is shutting down. Cadencr can't reach it until it restarts.",
      }),
    );
  });
});
