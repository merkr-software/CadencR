import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@/test-utils";
import { useTouchPinch, type ZoomAt } from "./useTouchPinch";

function Surface({ zoomAt }: { zoomAt: ZoomAt }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useTouchPinch(element, zoomAt);
  return <div ref={setElement} data-testid="surface" />;
}

function touches(points: [number, number][]): { clientX: number; clientY: number }[] {
  return points.map(([clientX, clientY]) => ({ clientX, clientY }));
}

function fire(target: Element, type: string, points: [number, number][]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches(points) });
  target.dispatchEvent(event);
  return event;
}

/** Frames run only when the test says so. */
const frames: FrameRequestCallback[] = [];
function flushFrames(): void {
  for (const callback of frames.splice(0)) callback(0);
}

beforeEach(() => {
  frames.length = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

const START: [number, number][] = [
  [100, 100],
  [200, 100],
];

describe("useTouchPinch", () => {
  it("zooms by the change in finger spread, around the fingers' midpoint", () => {
    const zoomAt = vi.fn();
    render(<Surface zoomAt={zoomAt} />);
    const surface = screen.getByTestId("surface");
    fire(surface, "touchstart", START);
    const move = fire(surface, "touchmove", [
      [50, 100],
      [250, 100],
    ]);
    // The pinch must not also scroll the viewport.
    expect(move.defaultPrevented).toBe(true);
    expect(zoomAt).not.toHaveBeenCalled();
    flushFrames();
    expect(zoomAt).toHaveBeenCalledWith(150, 100, 2);
  });

  it("applies the moves of one frame once, their factors multiplied", () => {
    const zoomAt = vi.fn();
    render(<Surface zoomAt={zoomAt} />);
    const surface = screen.getByTestId("surface");
    fire(surface, "touchstart", START);
    fire(surface, "touchmove", [
      [50, 100],
      [250, 100],
    ]);
    fire(surface, "touchmove", [
      [0, 100],
      [300, 100],
    ]);
    expect(frames).toHaveLength(1);
    flushFrames();
    expect(zoomAt).toHaveBeenCalledOnce();
    expect(zoomAt).toHaveBeenCalledWith(150, 100, 3);
  });

  it("leaves a one-finger drag to the browser's own panning", () => {
    const zoomAt = vi.fn();
    render(<Surface zoomAt={zoomAt} />);
    const surface = screen.getByTestId("surface");
    fire(surface, "touchstart", [[100, 100]]);
    const move = fire(surface, "touchmove", [[140, 100]]);
    flushFrames();
    expect(zoomAt).not.toHaveBeenCalled();
    expect(move.defaultPrevented).toBe(false);
  });

  it("stops after a finger lifts", () => {
    const zoomAt = vi.fn();
    render(<Surface zoomAt={zoomAt} />);
    const surface = screen.getByTestId("surface");
    fire(surface, "touchstart", START);
    fire(surface, "touchend", [[100, 100]]);
    fire(surface, "touchmove", [
      [0, 100],
      [300, 100],
    ]);
    flushFrames();
    expect(zoomAt).not.toHaveBeenCalled();
  });

  it("restarts from the fingers left when the count changes", () => {
    const zoomAt = vi.fn();
    render(<Surface zoomAt={zoomAt} />);
    const surface = screen.getByTestId("surface");
    fire(surface, "touchstart", START);
    // A third finger lands, then lifts: the two left, far apart, are the new baseline.
    fire(surface, "touchstart", [...START, [400, 400]]);
    fire(surface, "touchend", [
      [0, 100],
      [400, 100],
    ]);
    fire(surface, "touchmove", [
      [0, 100],
      [400, 100],
    ]);
    flushFrames();
    expect(zoomAt).not.toHaveBeenCalled();
    fire(surface, "touchmove", [
      [-200, 100],
      [600, 100],
    ]);
    flushFrames();
    expect(zoomAt).toHaveBeenCalledWith(200, 100, 2);
  });
});
