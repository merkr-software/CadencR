import { CadencrError, HOST_REPORTED_BACKEND_CODES, isReportedByHost } from "@cadencr/tab-sdk";
import { describe, expect, it, vi } from "vitest";

import { BackendFailureWatch, type BackendFailureDeps } from "./broker-backend-failures";
import { BrokerError } from "./broker-errors";

function deps() {
  return {
    report: vi.fn<BackendFailureDeps["report"]>(),
    clear: vi.fn<BackendFailureDeps["clear"]>(),
  } satisfies BackendFailureDeps;
}

const unsigned = new BrokerError(
  "PLUGIN_BACKEND_UNSIGNED",
  "the tab's backend `bin/darwin-aarch64/ports` is an unsigned arm64 executable, which macOS kills on launch; ad-hoc sign it: codesign -s - bin/darwin-aarch64/ports (the Rust linker does this by default)",
);

describe("BackendFailureWatch", () => {
  it("reports a blocking failure once per streak, with the service's explanation", () => {
    const sink = deps();
    const watch = new BackendFailureWatch("7:plugin:ports", sink);
    watch.failed("Ports", unsigned);
    watch.failed("Ports", unsigned);
    expect(sink.report).toHaveBeenCalledTimes(1);
    expect(sink.report).toHaveBeenCalledWith({
      instanceId: "7:plugin:ports",
      title: "Ports: its backend is not code-signed",
      detail: expect.stringMatching(
        /^The tab's backend .*codesign -s - bin\/darwin-aarch64\/ports/,
      ),
      restart: false,
    });
  });

  it("reports again when the failure changes, or after the backend answered", () => {
    const sink = deps();
    const watch = new BackendFailureWatch("7:plugin:ports", sink);
    watch.failed("Ports", new BrokerError("PLUGIN_BACKEND_NOT_READY", "never ready"));
    watch.failed("Ports", new BrokerError("PLUGIN_BACKEND_CRASHING", "crashed 3 times"));
    expect(sink.report).toHaveBeenCalledTimes(2);
    expect(sink.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Ports: its backend keeps crashing", restart: true }),
    );
    watch.answered();
    expect(sink.clear).toHaveBeenCalledWith("7:plugin:ports");
    watch.answered();
    expect(sink.clear).toHaveBeenCalledTimes(1);
    watch.failed("Ports", new BrokerError("PLUGIN_BACKEND_CRASHING", "crashed 3 times"));
    expect(sink.report).toHaveBeenCalledTimes(3);
  });

  it("leaves transient and method errors to the page", () => {
    const sink = deps();
    const watch = new BackendFailureWatch("7:plugin:ports", sink);
    for (const code of [
      "PLUGIN_BACKEND_TIMEOUT",
      "PLUGIN_BACKEND_BUSY",
      "PLUGIN_BACKEND_EXITED",
      "BAD_REQUEST",
      "DISCONNECTED",
    ]) {
      watch.failed("Ports", new BrokerError(code, "transient"));
    }
    watch.failed("Ports", new Error("socket hang up"));
    expect(sink.report).not.toHaveBeenCalled();
    watch.dispose();
    expect(sink.clear).not.toHaveBeenCalled();
  });

  it("tells the user to reinstall a backend modified after install", () => {
    const sink = deps();
    const watch = new BackendFailureWatch("7:plugin:ports", sink);
    watch.failed(
      "Ports",
      new BrokerError(
        "PLUGIN_BACKEND_TAMPERED",
        "the tab's backend /Users/me/.cadencr/plugins/managed-tabs/ports/revisions/1.0.1-ab12/bin/darwin-aarch64/ports differs from the binary its signed package names; reinstall the tab from the marketplace",
      ),
    );
    // The full path is the Activity's to show: the toast stays short.
    expect(sink.report).toHaveBeenCalledWith({
      instanceId: "7:plugin:ports",
      title: "Ports: its backend binary was modified after install",
      detail:
        "It differs from the binary its signed package names; its Activity shows which file. Reinstall or update the tab from the Marketplace.",
      restart: false,
    });
  });

  it("keeps the refused-starts toast short and offers the Activity's restart", () => {
    const sink = deps();
    const watch = new BackendFailureWatch("7:plugin:ports", sink);
    watch.failed(
      "Ports",
      new BrokerError(
        "PLUGIN_BACKEND_START_FAILING",
        "the tab's backend could not start 3 times in a minute; the tab's Activity says why",
      ),
    );
    expect(sink.report).toHaveBeenCalledWith({
      instanceId: "7:plugin:ports",
      title: "Ports: its backend keeps failing to start",
      detail: "The tab's backend could not start 3 times in a minute; the tab's Activity says why.",
      restart: true,
    });
  });

  it("reports a marketplace backend with no build for this platform", () => {
    const sink = deps();
    const watch = new BackendFailureWatch("7:plugin:ports", sink);
    watch.failed(
      "Ports",
      new BrokerError("PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM", "no backend for linux-x86_64"),
    );
    expect(sink.report).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Ports: its backend has no build for this platform",
        detail: "No backend for linux-x86_64.",
        restart: false,
      }),
    );
  });

  it("explains a backend start refused for want of a current revocation list", () => {
    const sink = deps();
    const watch = new BackendFailureWatch("7:plugin:ports", sink);
    watch.failed(
      "Ports",
      new BrokerError("MANAGED_TAB_POLICY_UNAVAILABLE", "the tab revocation list is stale"),
    );
    watch.failed("Ports", new BrokerError("PLUGIN_TAB_BLOCKED", "graph 1.0.0 is blocked"));
    expect(sink.report).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "Ports: Cadencr couldn't confirm it is still allowed to run native code",
        detail:
          "The tab revocation list is stale. Check your connection; the backend starts once the revocation list is reachable.",
      }),
    );
    expect(sink.report).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "Ports: it was blocked by Cadencr", restart: false }),
    );
  });

  it("offers a restart for a protocol mismatch and clears its report when the tab closes", () => {
    const sink = deps();
    const watch = new BackendFailureWatch("7:plugin:ports", sink);
    watch.failed(
      "Ports",
      new BrokerError("PLUGIN_BACKEND_PROTOCOL_MISMATCH", "the tab's backend speaks protocol 2"),
    );
    expect(sink.report).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "The tab's backend speaks protocol 2.", restart: true }),
    );
    watch.dispose();
    expect(sink.clear).toHaveBeenCalledTimes(1);
  });

  it("surfaces exactly the codes the SDK tells pages Cadencr reports itself", () => {
    for (const code of HOST_REPORTED_BACKEND_CODES) {
      const sink = deps();
      new BackendFailureWatch("7:plugin:ports", sink).failed("Ports", new BrokerError(code, "x"));
      expect(sink.report, code).toHaveBeenCalledTimes(1);
      expect(isReportedByHost(new CadencrError(code, "x"))).toBe(true);
    }
  });

  it("offers a restart when the backend keeps failing to start", () => {
    const sink = deps();
    new BackendFailureWatch("7:plugin:ports", sink).failed(
      "Ports",
      new BrokerError("PLUGIN_BACKEND_START_FAILING", "could not start 5 times in a minute"),
    );
    expect(sink.report).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Ports: its backend keeps failing to start",
        restart: true,
      }),
    );
  });
});
