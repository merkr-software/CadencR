import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * `@webgpu/types` (referenced globally in vite-env.d.ts for the terminal
 * renderer) merges a `getContext("webgpu")` overload onto HTMLCanvasElement.
 * TS collapses overloaded methods to their last signature when inferred
 * generically, so `vi.spyOn(..., "getContext")` types as the WebGPU overload
 * unless narrowed explicitly here.
 */
type GetContext2d = (contextId: "2d") => CanvasRenderingContext2D | null;

function spyOnGetContext2d(): Mock<GetContext2d> {
  return vi.spyOn(HTMLCanvasElement.prototype, "getContext") as unknown as Mock<GetContext2d>;
}

/** Make the next canvas 2d context return `widthFor(char)` from measureText. */
function stubCanvasContext(widthFor: (char: string) => number): void {
  const ctx = {
    font: "",
    measureText: (text: string) => ({ width: widthFor(text) }),
  } as unknown as CanvasRenderingContext2D;
  spyOnGetContext2d().mockReturnValue(ctx);
}

async function loadIsMonospace(): Promise<(family: string) => boolean> {
  const { isMonospace } = await import("./isMonospace");
  return isMonospace;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("isMonospace", () => {
  it("returns true when all sample glyphs measure equal", async () => {
    stubCanvasContext(() => 9.6);
    const isMonospace = await loadIsMonospace();
    expect(isMonospace("Menlo")).toBe(true);
  });

  it("returns false when glyph widths diverge", async () => {
    const widths: Record<string, number> = { i: 3, W: 12, M: 11, l: 3 };
    stubCanvasContext((c) => widths[c] ?? 8);
    const isMonospace = await loadIsMonospace();
    expect(isMonospace("Arial")).toBe(false);
  });

  it("returns false when no 2d context is available", async () => {
    spyOnGetContext2d().mockReturnValue(null);
    const isMonospace = await loadIsMonospace();
    expect(isMonospace("Whatever")).toBe(false);
  });

  it("retries canvas acquisition after a transient failure", async () => {
    const context = {
      font: "",
      measureText: () => ({ width: 9.6 }),
    } as unknown as CanvasRenderingContext2D;
    const getContext = spyOnGetContext2d().mockReturnValueOnce(null).mockReturnValue(context);
    const isMonospace = await loadIsMonospace();
    const callsBeforeChecks = getContext.mock.calls.length;

    expect(isMonospace("Menlo")).toBe(false);
    expect(isMonospace("Menlo")).toBe(true);
    expect(getContext.mock.calls.length - callsBeforeChecks).toBe(2);
  });

  it("reuses one canvas context across font checks", async () => {
    const getContext = spyOnGetContext2d().mockReturnValue({
      font: "",
      measureText: () => ({ width: 9.6 }),
    } as unknown as CanvasRenderingContext2D);
    const isMonospace = await loadIsMonospace();
    const callsBeforeChecks = getContext.mock.calls.length;

    expect(isMonospace("Menlo")).toBe(true);
    expect(isMonospace("Monaco")).toBe(true);
    expect(getContext.mock.calls.length - callsBeforeChecks).toBe(1);
  });
});
