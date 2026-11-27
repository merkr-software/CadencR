import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@/test-utils";
import { Markdown } from "@/components/Markdown";
import { __markdownCacheTestHelpers as cache } from "@/components/markdown/markdown-tree-cache";

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));

type Callback = (entries: { target: Element }[]) => void;
const observed = new Map<Element, Callback>();

class FakeResizeObserver {
  constructor(private readonly callback: Callback) {}
  observe(target: Element): void {
    observed.set(target, this.callback);
  }
  unobserve(target: Element): void {
    observed.delete(target);
  }
  disconnect(): void {}
}

function resize(target: Element): void {
  act(() => observed.get(target)?.([{ target }]));
}

function setWidths(element: Element, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 10 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 10 });
}

beforeEach(() => {
  cache.clear();
  observed.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe("a phone code block's overflow", () => {
  it("turns into a preview when a streamed line only grows wider", () => {
    const { container } = render(
      <Markdown content={"```sh\necho short\n```"} cacheKey="overflow-stream" />,
    );
    const pre = container.querySelector("pre");
    const code = pre?.querySelector("code");
    if (!pre || !code) throw new Error("no code block");
    // The code's own box follows its longest line, so its growth is observed.
    expect(code).toHaveClass("block", "w-max", "min-w-full");
    expect(observed.has(code)).toBe(true);
    expect(container.querySelector("[data-rich-code]")).toHaveAttribute("data-rich-code", "inline");

    // The line gets longer; the clipping box keeps its width.
    setWidths(pre, 900, 360);
    resize(code);
    expect(container.querySelector("[data-rich-code]")).toHaveAttribute(
      "data-rich-code",
      "preview",
    );
  });
});
