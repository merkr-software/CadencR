import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { GlobalErrorBoundary } from "./GlobalErrorBoundary";

const reportRendererError = vi.fn<(_payload: unknown) => Promise<void>>(() => Promise.resolve());

function Boom(): never {
  throw new Error("root exploded");
}

describe("GlobalErrorBoundary", () => {
  beforeEach(() => {
    clearDesktopBridgeOverrideForTests();
    reportRendererError.mockClear();
  });

  it("renders children when the app shell is healthy", () => {
    render(
      <GlobalErrorBoundary>
        <span>healthy app</span>
      </GlobalErrorBoundary>,
    );

    expect(screen.getByText("healthy app")).toBeInTheDocument();
  });

  it("shows a whole-app fallback and reports component diagnostics", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setDesktopBridgeOverrideForTests({
      reportRendererError,
    });

    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>,
    );

    expect(screen.getByText(/Cadencr UI crashed/i)).toBeInTheDocument();
    expect(screen.getByText(/root exploded/)).toBeInTheDocument();
    expect(reportRendererError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "react-boundary",
        message: "root exploded",
        componentStack: expect.stringContaining("Boom"),
      }),
    );
    errSpy.mockRestore();
  });
});
