import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalCoreInstance } from "./TerminalCoreInstance";

const state = vi.hoisted(() => ({
  hostRef: { current: null as HTMLDivElement | null },
  status: "loading",
  isLoading: true,
  error: null as string | null,
}));
vi.mock("./useTerminalCoreInstanceController", () => ({
  useTerminalCoreInstanceController: () => state,
}));

describe("terminal renderer host", () => {
  it("measures an unpadded content host and preserves it through loading/error states", () => {
    const { rerender } = render(<TerminalCoreInstance featureId={1} projectId={1} />);
    const host = state.hostRef.current;
    expect(host).not.toBeNull();
    expect(host).toHaveClass("relative");
    expect(host?.style.paddingLeft).toBe("");
    expect(host?.parentElement?.style.paddingLeft).toBe("8px");
    expect(host?.parentElement?.style.paddingRight).toBe("8px");
    state.status = "error";
    state.isLoading = false;
    state.error = "Renderer failed";
    rerender(<TerminalCoreInstance featureId={1} projectId={1} />);
    expect(state.hostRef.current).toBe(host);
  });
});
