import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { GlobalErrorBoundary } from "./GlobalErrorBoundary";
import { toast } from "sonner";

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

  it("retains a non-Error throw in the copied diagnostic details", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setDesktopBridgeOverrideForTests({ reportRendererError });
    function ThrowString(): never {
      throw "plain string failure";
    }
    render(
      <GlobalErrorBoundary>
        <ThrowString />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText(/"message": "plain string failure"/)).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it("shows persistence failures when the router and its normal toast host have crashed", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setDesktopBridgeOverrideForTests({
      reportRendererError: vi.fn().mockRejectedValue(new Error("Disk full")),
    });
    function UnsaveableCrash(): never {
      throw new Error("unsaveable crash");
    }
    render(
      <GlobalErrorBoundary>
        <UnsaveableCrash />
      </GlobalErrorBoundary>,
    );
    expect(await screen.findByText("Could not save diagnostic report")).toBeInTheDocument();
    expect(
      screen.getByText(/Copy the error details before reloading.*Disk full/),
    ).toBeInTheDocument();
    toast.dismiss("renderer-diagnostics-persistence");
    errSpy.mockRestore();
  });

  it("shows a whole-app fallback and reports component diagnostics", async () => {
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
    await Promise.resolve();
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
