import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";

type Callback = (entries: { target: Element }[]) => void;
const observers: { callback: Callback; targets: Set<Element> }[] = [];

class FakeResizeObserver {
  private readonly entry: { callback: Callback; targets: Set<Element> };
  constructor(callback: Callback) {
    this.entry = { callback, targets: new Set() };
    observers.push(this.entry);
  }
  observe(target: Element): void {
    this.entry.targets.add(target);
  }
  unobserve(target: Element): void {
    this.entry.targets.delete(target);
  }
  disconnect(): void {
    this.entry.targets.clear();
  }
}

function resize(target: Element): void {
  act(() => {
    for (const observer of observers) {
      if (observer.targets.has(target)) observer.callback([{ target }]);
    }
  });
}

function setBox(element: Element, box: { scrollWidth: number; clientWidth: number }): void {
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: box.scrollWidth });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: box.clientWidth });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 10 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 10 });
}

beforeEach(() => {
  vi.resetModules();
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

async function renderProbe(enabled = true) {
  const { useContentOverflow } = await import("./useContentOverflow");
  function Probe({ on }: { on: boolean }) {
    const { ref, wide } = useContentOverflow(on);
    return (
      <div ref={ref} data-testid="clip" data-wide={wide}>
        <table />
      </div>
    );
  }
  const view = render(<Probe on={enabled} />);
  return { ...view, Probe };
}

describe("useContentOverflow", () => {
  it("reports content wider than its box once the box is measured", async () => {
    await renderProbe();
    const clip = screen.getByTestId("clip");
    expect(clip).toHaveAttribute("data-wide", "false");

    setBox(clip, { scrollWidth: 600, clientWidth: 400 });
    resize(clip);
    expect(clip).toHaveAttribute("data-wide", "true");
  });

  it("watches the content too, which grows without resizing its box", async () => {
    await renderProbe();
    const clip = screen.getByTestId("clip");
    const table = clip.querySelector("table");
    if (!table) throw new Error("no table");
    setBox(clip, { scrollWidth: 401, clientWidth: 400 });
    resize(table);
    expect(clip).toHaveAttribute("data-wide", "false");
    setBox(clip, { scrollWidth: 800, clientWidth: 400 });
    resize(table);
    expect(clip).toHaveAttribute("data-wide", "true");
  });

  it("keeps its answer while the block is laid out at zero width (a hidden workspace)", async () => {
    await renderProbe();
    const clip = screen.getByTestId("clip");
    setBox(clip, { scrollWidth: 800, clientWidth: 400 });
    resize(clip);
    setBox(clip, { scrollWidth: 0, clientWidth: 0 });
    resize(clip);
    expect(clip).toHaveAttribute("data-wide", "true");
  });

  it("watches nothing when disabled", async () => {
    await renderProbe(false);
    expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
  });
});
