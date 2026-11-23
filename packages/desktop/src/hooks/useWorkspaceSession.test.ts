// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry, type SessionEntry } from "@/stores/ws-session-types";
import {
  BACKGROUND_SESSION_SAMPLE_MS,
  createSessionSource,
  useWorkspaceSession,
} from "./useWorkspaceSession";

const SESSION_ID = "ws-feature-1";

/** A new entry object, as every stream delta produces. */
function touchSession(): void {
  useWsSessionStore.setState((state) => ({
    sessions: { ...state.sessions, [SESSION_ID]: { ...createSessionEntry() } },
  }));
}

describe("createSessionSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWsSessionStore.setState({ sessions: {} });
    touchSession();
  });

  afterEach(() => vi.useRealTimers());

  it("follows the store while the workspace is on screen", () => {
    const source = createSessionSource(createWorkspaceActivity(true), SESSION_ID);
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    touchSession();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toBe(useWsSessionStore.getState().sessions[SESSION_ID]);
    unsubscribe();
  });

  it("holds the entry of a hidden workspace between two samples", () => {
    const activity = createWorkspaceActivity(true);
    const source = createSessionSource(activity, SESSION_ID);
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    const whenHidden = source.getSnapshot();
    activity.set(false);
    listener.mockClear();

    touchSession();
    touchSession();

    expect(listener).not.toHaveBeenCalled();
    expect(source.getSnapshot()).toBe(whenHidden);

    vi.advanceTimersByTime(BACKGROUND_SESSION_SAMPLE_MS);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toBe(useWsSessionStore.getState().sessions[SESSION_ID]);
    unsubscribe();
  });

  it("does not notify for a hidden session that did not change", () => {
    const activity = createWorkspaceActivity(false);
    const source = createSessionSource(activity, SESSION_ID);
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    vi.advanceTimersByTime(BACKGROUND_SESSION_SAMPLE_MS * 3);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("reads the live entry again the moment the workspace is shown", () => {
    const activity = createWorkspaceActivity(false);
    const source = createSessionSource(activity, SESSION_ID);
    const unsubscribe = source.subscribe(() => {});
    const whenHidden = source.getSnapshot();
    touchSession();
    expect(source.getSnapshot()).toBe(whenHidden);

    activity.set(true);

    expect(source.getSnapshot()).toBe(useWsSessionStore.getState().sessions[SESSION_ID]);
    unsubscribe();
  });

  it("stops sampling once unsubscribed", () => {
    const source = createSessionSource(createWorkspaceActivity(false), SESSION_ID);
    const listener = vi.fn();
    source.subscribe(listener)();

    touchSession();
    vi.advanceTimersByTime(BACKGROUND_SESSION_SAMPLE_MS * 2);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWsSessionStore.setState({ sessions: {} });
    touchSession();
  });

  afterEach(() => vi.useRealTimers());

  /** Two consumers of one session in one component, as the workspace block has. */
  function renderTwoConsumers(activity: WorkspaceActivityController) {
    const seen: Array<[SessionEntry | undefined, SessionEntry | undefined]> = [];
    function Workspace() {
      seen.push([useWorkspaceSession(SESSION_ID), useWorkspaceSession(SESSION_ID)]);
      return null;
    }
    const wrap = (children: ReactNode) =>
      createElement(WorkspaceActivityProvider, { value: activity }, children);
    const view = render(wrap(createElement(Workspace)));
    return { seen, view };
  }

  it("samples a hidden session once for all its consumers, and renders them together", () => {
    const setInterval = vi.spyOn(window, "setInterval");
    const { seen } = renderTwoConsumers(createWorkspaceActivity(false));
    const sampling = setInterval.mock.calls.filter(
      ([, delay]) => delay === BACKGROUND_SESSION_SAMPLE_MS,
    );
    expect(sampling).toHaveLength(1);
    seen.length = 0;

    touchSession();
    act(() => void vi.advanceTimersByTime(BACKGROUND_SESSION_SAMPLE_MS));

    const latest = useWsSessionStore.getState().sessions[SESSION_ID];
    expect(seen).toEqual([[latest, latest]]);
  });

  it("stops sampling once its last consumer is gone", () => {
    const clearInterval = vi.spyOn(window, "clearInterval");
    const { view } = renderTwoConsumers(createWorkspaceActivity(false));

    view.unmount();

    expect(clearInterval).toHaveBeenCalledTimes(1);
  });
});
