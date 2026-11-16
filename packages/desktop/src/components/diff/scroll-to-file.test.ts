// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scrollFileToTop } from "./scroll-to-file";

// Drive requestAnimationFrame manually so we can step the settle loop frame by
// frame. scrollFileToTop chains one rAF at a time, so each tick() runs the
// single pending callback (which may schedule the next).
let frames: Map<number, FrameRequestCallback>;
let nextId: number;

function tick(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(0);
}

beforeEach(() => {
  frames = new Map();
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    const id = nextId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rect = (top: number): DOMRect => ({ top }) as DOMRect;

/**
 * Build a scroll container whose child file sits `fileTop` px below the
 * container top, with scrollTop moving the child toward the top as it grows.
 */
function makeContainer(file: string, fileTop: number) {
  const container = document.createElement("div");
  const el = document.createElement("div");
  el.setAttribute("data-file", file);
  container.appendChild(el);

  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  container.getBoundingClientRect = () => rect(0);
  el.getBoundingClientRect = () => rect(fileTop - scrollTop);
  return { container, getScrollTop: () => scrollTop };
}

describe("scrollFileToTop", () => {
  it("pins the file to the container top and stops once settled", () => {
    const { container, getScrollTop } = makeContainer("src/a.ts", 100);
    scrollFileToTop(container, "src/a.ts");

    tick(); // scrolls by the 100px delta
    expect(getScrollTop()).toBe(100);
    tick(); // aligned (stable 1)
    tick(); // aligned (stable 2) -> stops scheduling

    expect(getScrollTop()).toBe(100);
    expect(frames.size).toBe(0);
  });

  it("re-pins when the virtualizer shifts the file after the initial jump", () => {
    const container = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("data-file", "src/a.ts");
    container.appendChild(el);
    let scrollTop = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
    container.getBoundingClientRect = () => rect(0);
    // The file's true offset grows by 50px after the first frame (a file above
    // it finished rendering), so a one-shot scroll would have landed short.
    let extra = 0;
    el.getBoundingClientRect = () => rect(100 + extra - scrollTop);

    scrollFileToTop(container, "src/a.ts");
    tick();
    expect(scrollTop).toBe(100);
    extra = 50; // virtualizer reconciles heights above the target
    tick();
    expect(scrollTop).toBe(150);
  });

  it("keeps tracking a far jump while a large diff reconciles many file heights", () => {
    const container = document.createElement("div");
    const el = document.createElement("div");
    el.setAttribute("data-file", "src/far-away.ts");
    container.appendChild(el);
    let scrollTop = 0;
    let measuredTop = 1_000;
    Object.defineProperty(container, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
      configurable: true,
    });
    container.getBoundingClientRect = () => rect(0);
    el.getBoundingClientRect = () => rect(measuredTop - scrollTop);

    scrollFileToTop(container, "src/far-away.ts");
    for (let index = 0; index < 30; index += 1) {
      tick();
      measuredTop += 25;
    }
    tick();

    expect(scrollTop).toBe(measuredTop);
    expect(frames.size).toBeGreaterThan(0);
  });

  it("bails out within a couple frames when the file is absent", () => {
    const { container, getScrollTop } = makeContainer("src/a.ts", 100);
    scrollFileToTop(container, "does/not/exist.ts");

    tick();
    tick();

    expect(getScrollTop()).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("supersedes an in-flight scroll so concurrent calls don't fight", () => {
    const container = document.createElement("div");
    let scrollTop = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
    container.getBoundingClientRect = () => rect(0);
    for (const [file, top] of [
      ["a.ts", 100],
      ["b.ts", 200],
    ] as const) {
      const el = document.createElement("div");
      el.setAttribute("data-file", file);
      el.getBoundingClientRect = () => rect(top - scrollTop);
      container.appendChild(el);
    }

    scrollFileToTop(container, "a.ts");
    scrollFileToTop(container, "b.ts"); // cancels the first before it runs
    tick();

    expect(scrollTop).toBe(200); // landed on the second target, not the first
  });

  it("can hand control to exact review-thread alignment", () => {
    const { container, getScrollTop } = makeContainer("src/a.ts", 100);
    const cancel = scrollFileToTop(container, "src/a.ts");

    cancel();
    tick();

    expect(getScrollTop()).toBe(0);
    expect(frames.size).toBe(0);
  });
});
