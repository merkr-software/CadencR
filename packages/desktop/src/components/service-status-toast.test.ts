// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { isValidElement } from "react";
import { uiI18n } from "@/lib/i18n/ui";
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
  cleanup();
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

    renderMessage(loading.mock.calls[0][0]);
    expect(screen.getByText("Restarting Cadencr's service…")).toBeTruthy();
    expect(loading.mock.calls[0][1]).toEqual({
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
    renderMessage(success.mock.calls[0][0]);
    expect(screen.getByText("Cadencr's service is running again")).toBeTruthy();
    expect(success.mock.calls[0][1]).toEqual(
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

    const [title, options] = error.mock.calls.at(-1)!;
    renderMessage(title);
    renderMessage(options?.description);
    expect(screen.getByText("Cadencr's service stopped")).toBeTruthy();
    const refusal = "Cadencr is shutting down. Cadencr can't reach it until it restarts.";
    expect(screen.getByText(refusal)).toBeTruthy();
    const language = uiI18n.language;
    uiI18n.addResource("fr-CA", "ui", "system.service.stopped", "Service arrêté");
    uiI18n.addResource("fr-CA", "ui", "system.service.downDetail", "Motif : {{reason}}");
    try {
      await act(() => uiI18n.changeLanguage("fr-CA").then(() => {}));
      expect(screen.getByText("Motif : Cadencr is shutting down.")).toBeTruthy();
      expect(screen.getByText("Service arrêté")).toBeTruthy();
      await act(() => uiI18n.changeLanguage(language).then(() => {}));
      expect(screen.getByText(refusal)).toBeTruthy();
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      uiI18n.removeResourceBundle("fr-CA", "ui");
      await act(() => uiI18n.changeLanguage(language).then(() => {}));
    }
  });
});

function renderMessage(node: unknown): void {
  if (!isValidElement(node)) throw new Error("Expected a rendered toast message");
  render(node);
}
