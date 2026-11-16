// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamFollowGlide } from "./stream-follow-glide";

const VIEWPORT = 600;

/** Animation frames run only when a test steps them, with explicit timestamps. */
const frames = new Map<number, FrameRequestCallback>();
let lastFrameId = 0;

function stepFrame(time: number): void {
  const queued = [...frames.values()];
  frames.clear();
  for (const callback of queued) callback(time);
}

function stream() {
  const scroller = document.createElement("div");
  const list = document.createElement("div");
  list.setAttribute("data-testid", "virtuoso-item-list");
  scroller.appendChild(list);
  document.body.appendChild(scroller);
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT });
  const row = document.createElement("div");
  list.appendChild(row);
  const offset = (): number => {
    const match = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform);
    return match ? Number(match[1]) : 0;
  };
  return { scroller, list, row, offset, glide: new StreamFollowGlide(scroller) };
}

describe("StreamFollowGlide", () => {
  beforeEach(() => {
    frames.clear();
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      lastFrameId += 1;
      frames.set(lastFrameId, callback);
      return lastFrameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("holds the rows where they were, then glides them up to the pinned position", () => {
    const { list, row, offset, glide } = stream();

    expect(glide.absorb(32)).toBe(true);
    // Same frame as the pin: nothing has visibly moved yet, and the new line
    // is clipped at the footer's edge instead of drawn over the timer.
    expect(offset()).toBe(32);
    expect(list.style.overflowY).toBe("clip");

    const seen: number[] = [];
    for (let time = 16; time <= 400; time += 16) {
      stepFrame(time);
      seen.push(offset());
    }
    // Monotonic: the rows only ever move up, never past where they rest.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    expect(row.style.transform).toBe("");
    expect(list.style.overflowY).toBe("");
    expect(frames.size).toBe(0);
  });

  it("carries a new line into a glide already under way instead of restarting it", () => {
    const { offset, glide } = stream();
    glide.absorb(32);
    stepFrame(16);
    stepFrame(48);
    const midway = offset();
    expect(midway).toBeLessThan(32);

    glide.absorb(32);
    expect(offset()).toBeCloseTo(midway + 32, 5);
    // One frame loop, not one per line.
    expect(frames.size).toBe(1);
  });

  it("moves a row mounted mid-glide with the others", () => {
    const { list, row, glide } = stream();
    glide.absorb(32);
    const mounted = document.createElement("div");
    list.appendChild(mounted);

    stepFrame(16);
    expect(mounted.style.transform).toBe(row.style.transform);
    expect(mounted.style.transform).not.toBe("");
  });

  it("snaps a jump too large to be streaming", () => {
    const { row, glide } = stream();
    glide.absorb(20);

    expect(glide.absorb(VIEWPORT / 2 + 1)).toBe(false);
    expect(row.style.transform).toBe("");
    expect(frames.size).toBe(0);
  });

  it("hands back the offset still in flight when released", () => {
    const { list, row, glide } = stream();
    glide.absorb(40);

    expect(glide.release()).toBe(40);
    expect(row.style.transform).toBe("");
    expect(list.style.overflowY).toBe("");
    expect(frames.size).toBe(0);
    expect(glide.release()).toBe(0);
  });

  it("settles at once after a long frame (a long task, a hidden window)", () => {
    const { row, glide } = stream();
    glide.absorb(40);

    stepFrame(1_000);
    expect(row.style.transform).toBe("");
    expect(frames.size).toBe(0);
  });
});
