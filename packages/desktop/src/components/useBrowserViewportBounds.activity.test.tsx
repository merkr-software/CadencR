import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceActivity } from "@/components/workspace-pool/workspace-activity";
import { createBrowserViewportBoundsTracker } from "./useBrowserViewportBounds";

let animationFrameCallbacks: Array<FrameRequestCallback> = [];

function flushAnimationFrames(): void {
  const callbacks = animationFrameCallbacks;
  animationFrameCallbacks = [];
  for (const callback of callbacks) callback(0);
}

function placeholder(): HTMLDivElement {
  const node = document.createElement("div");
  node.getBoundingClientRect = () => new DOMRect(12, 34, 640, 480);
  return node;
}

const MEASURED = { x: 12, y: 34, width: 640, height: 480 };
const NONE = { x: 0, y: 0, width: 0, height: 0 };

describe("a native view in a workspace kept mounted but hidden", () => {
  beforeEach(() => {
    animationFrameCallbacks = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reports no bounds while its workspace is hidden, though the placeholder keeps its size", () => {
    const onBounds = vi.fn();
    const tracker = createBrowserViewportBoundsTracker({
      onBounds,
      activity: createWorkspaceActivity(false),
    });

    tracker.attach(placeholder());
    flushAnimationFrames();

    expect(onBounds).toHaveBeenLastCalledWith(NONE);
    tracker.dispose();
  });

  it("is removed in the same task as the switch, and measured again once shown", () => {
    const onBounds = vi.fn();
    const activity = createWorkspaceActivity(true);
    const tracker = createBrowserViewportBoundsTracker({ onBounds, activity });
    tracker.attach(placeholder());
    flushAnimationFrames();
    expect(onBounds).toHaveBeenLastCalledWith(MEASURED);

    activity.set(false);
    // No frame flushed: the view must not survive into the next workspace's paint.
    expect(onBounds).toHaveBeenLastCalledWith(NONE);

    activity.set(true);
    flushAnimationFrames();
    expect(onBounds).toHaveBeenLastCalledWith(MEASURED);
    tracker.dispose();
  });

  it("stops following its workspace once disposed", () => {
    const onBounds = vi.fn();
    const activity = createWorkspaceActivity(true);
    const tracker = createBrowserViewportBoundsTracker({ onBounds, activity });
    tracker.attach(placeholder());
    flushAnimationFrames();
    tracker.dispose();
    onBounds.mockClear();

    activity.set(false);

    expect(onBounds).not.toHaveBeenCalled();
  });
});
