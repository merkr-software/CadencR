import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { act, render, screen } from "@/test-utils";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useInViewport } from "./useInViewport";

/** The latest observer's callback, so the test reports what it likes. */
let report: (isIntersecting: boolean) => void = () => {};

class ControlledObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe = (el: Element): void => {
    report = (isIntersecting) =>
      this.callback(
        [{ isIntersecting, target: el } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    report(true);
  };
  unobserve = (): void => {};
  disconnect = (): void => {};
}

function Row() {
  const viewportRoot = useRef<HTMLElement | null>(null);
  const { setRef, inView } = useInViewport(viewportRoot);
  return <span ref={setRef}>{inView ? "in view" : "out of view"}</span>;
}

function renderInWorkspace(activity: WorkspaceActivityController, children: ReactNode) {
  return render(<WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>);
}

describe("useInViewport in a workspace kept mounted but hidden", () => {
  beforeEach(() => vi.stubGlobal("IntersectionObserver", ControlledObserver));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps its last state while hidden off screen", () => {
    const activity = createWorkspaceActivity(true);
    renderInWorkspace(activity, <Row />);
    expect(screen.getByText("in view")).toBeInTheDocument();

    act(() => activity.set(false));
    act(() => report(false));

    expect(screen.getByText("in view")).toBeInTheDocument();
  });

  it("follows the viewport while shown", () => {
    renderInWorkspace(createWorkspaceActivity(true), <Row />);

    act(() => report(false));
    expect(screen.getByText("out of view")).toBeInTheDocument();

    act(() => report(true));
    expect(screen.getByText("in view")).toBeInTheDocument();
  });
});
