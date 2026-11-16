import { act, Component, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "./desktop-bridge";
import { reactRootErrorHandlers } from "./react-root-error-reporting";
import { reportReactBoundaryError } from "./renderer-error-reporting";

class LocalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? "Local fallback" : this.props.children;
  }
}

function BrokenPanel(): never {
  throw new Error("panel failed");
}

// An intentional fixture loop; this does not reproduce the application streaming bug.
function NestedUpdateLoop(): ReactNode {
  const [count, setCount] = useState(0);
  useLayoutEffect(() => setCount((n) => n + 1));
  return count;
}

describe("React root error diagnostics", () => {
  const report = vi.fn(() => Promise.resolve());
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    report.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setDesktopBridgeOverrideForTests({ reportRendererError: report });
    container = document.createElement("div");
    root = createRoot(container, reactRootErrorHandlers);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    clearDesktopBridgeOverrideForTests();
    vi.restoreAllMocks();
  });

  it("captures a local boundary that does not forward diagnostics", async () => {
    await act(() =>
      root.render(
        <LocalBoundary>
          <BrokenPanel />
        </LocalBoundary>,
      ),
    );
    expect(container.textContent).toBe("Local fallback");
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "react-boundary",
        message: "panel failed",
        componentStack: expect.stringContaining("BrokenPanel"),
      }),
    );
  });

  it("demonstrates the diagnostic gap with React's default root handlers", async () => {
    await act(() => root.unmount());
    root = createRoot(container);
    await act(() =>
      root.render(
        <LocalBoundary>
          <BrokenPanel />
        </LocalBoundary>,
      ),
    );
    expect(container.textContent).toBe("Local fallback");
    expect(report).not.toHaveBeenCalled();
  });

  it("captures uncaught React errors with the component stack", () => {
    // React's development act() deliberately bypasses onUncaughtError.
    flushSync(() => root.render(<BrokenPanel />));
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "react-uncaught",
        message: "panel failed",
        componentStack: expect.stringContaining("BrokenPanel"),
      }),
    );
  });

  it("captures a nested-update failure once while keeping the global fallback", async () => {
    await act(() =>
      root.render(
        <GlobalErrorBoundary>
          <NestedUpdateLoop />
        </GlobalErrorBoundary>,
      ),
    );
    expect(container.textContent).toContain("Reload UI");
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "react-boundary",
        message: expect.stringContaining("Maximum update depth exceeded"),
        componentStack: expect.stringContaining("NestedUpdateLoop"),
      }),
    );
  });

  it("reports recovery context and handles non-Error throws", () => {
    reactRootErrorHandlers.onRecoverableError("render retried", { componentStack: "at Panel" });
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "react-recoverable",
        message: "render retried",
        componentStack: "at Panel",
      }),
    );
  });

  it("deduplicates root/boundary pairs and immediate repeated failures", async () => {
    const error = new Error("same instance");
    reactRootErrorHandlers.onCaughtError(error, {
      componentStack: "at Panel",
    });
    reportReactBoundaryError(error, "at Panel");
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
    reactRootErrorHandlers.onCaughtError(error, {
      componentStack: "at Panel",
    });
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
