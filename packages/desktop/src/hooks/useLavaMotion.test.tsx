// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeHalo } from "@/lib/themes/chrome";
import { useLavaMotion } from "./useLavaMotion";

const HALO: ThemeHalo = {
  color: "#5fb3e0",
  size: 72,
  x: 28,
  y: 32,
  blur: 80,
  opacity: 0.5,
  drift: 28,
};

/** The frame the hook asked for, so the test can drive the clock itself. */
let pending: FrameRequestCallback | null = null;
let clock = 0;

function Harness({
  halos,
  speed,
}: {
  halos: ThemeHalo[];
  speed: number | null;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLavaMotion(ref, halos, speed);
  return (
    <div ref={ref}>
      {halos.map((_, index) => (
        <div key={index} className="halo" />
      ))}
    </div>
  );
}

/** Run one frame `ms` after the previous one. */
function frame(ms: number): void {
  clock += ms;
  const callback = pending;
  pending = null;
  callback?.(clock);
}

function transforms(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(".halo")].map((h) => h.style.transform);
}

describe("useLavaMotion", () => {
  beforeEach(() => {
    pending = null;
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pending = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      pending = null;
    });
    document.documentElement.removeAttribute("data-ambient-paused");
    document.documentElement.removeAttribute("data-animations");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-ambient-paused");
    document.documentElement.removeAttribute("data-animations");
  });

  it("does nothing at all when the field is not a lava lamp", () => {
    const { container } = render(<Harness halos={[HALO]} speed={null} />);

    expect(pending).toBeNull();
    expect(transforms(container)).toEqual([""]);
  });

  it("moves the halos once frames start arriving", () => {
    const { container } = render(<Harness halos={[HALO, HALO]} speed={4} />);
    expect(pending).not.toBeNull();

    // The first frame only starts the clock: a frame that ran no simulation
    // step writes nothing.
    frame(0);
    expect(transforms(container)).toEqual(["", ""]);

    frame(500);
    const first = transforms(container);
    expect(first[0]).toMatch(/^translate3d\(/);

    frame(1000);
    expect(transforms(container)).not.toEqual(first);
  });

  it("writes nothing while the ambient layer is paused", () => {
    const { container } = render(<Harness halos={[HALO]} speed={4} />);
    document.documentElement.setAttribute("data-ambient-paused", "");

    frame(0);
    frame(500);

    expect(transforms(container)).toEqual([""]);
  });

  it("writes nothing under the global motion kill-switch", () => {
    const { container } = render(<Harness halos={[HALO]} speed={4} />);
    document.documentElement.setAttribute("data-animations", "off");

    frame(0);
    frame(500);

    expect(transforms(container)).toEqual([""]);
  });

  it("hands the halos back to their theme positions on unmount", () => {
    const { container, unmount } = render(<Harness halos={[HALO]} speed={4} />);
    frame(0);
    frame(500);
    expect(transforms(container)[0]).not.toBe("");

    unmount();
    expect(container.querySelector<HTMLElement>(".halo")?.style.transform ?? "").toBe("");
  });

  it("keeps the blobs where they are when the pace changes", () => {
    const { container, rerender } = render(<Harness halos={[HALO]} speed={4} />);
    frame(0);
    frame(500);
    const before = transforms(container)[0];

    // A speed change must not re-seed: the slider is dragged mid-motion.
    rerender(<Harness halos={[HALO]} speed={12} />);
    expect(transforms(container)[0]).toBe(before);
  });

  it("re-seeds when the theme's composition changes", () => {
    const { container, rerender } = render(<Harness halos={[HALO]} speed={4} />);
    frame(0);
    frame(500);
    const before = transforms(container)[0];

    rerender(<Harness halos={[{ ...HALO, x: 79, y: 61 }]} speed={4} />);
    frame(0);
    frame(500);

    expect(transforms(container)[0]).not.toBe(before);
  });
});
