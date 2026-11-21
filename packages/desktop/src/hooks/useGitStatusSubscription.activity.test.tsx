import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook } from "@/test-utils";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useGitStatusSubscription } from "./useGitStatusSubscription";

const FEATURE_ID = 7;

function renderSubscription(activity: WorkspaceActivityController) {
  return renderHook(() => useGitStatusSubscription(FEATURE_ID), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
    ),
  });
}

describe("git status subscription of a workspace kept mounted but hidden", () => {
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => unsubscribe);

  beforeEach(() => {
    unsubscribe.mockClear();
    subscribe.mockClear();
    useSessionStatusStore.setState({ isConnected: true, subscribeGitStatus: subscribe });
  });

  it("is dropped while hidden and taken again once shown", () => {
    const activity = createWorkspaceActivity(true);
    renderSubscription(activity);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(FEATURE_ID);

    activity.set(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    activity.set(true);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("is not taken by a workspace mounted hidden", () => {
    renderSubscription(createWorkspaceActivity(false));
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("ends with its workspace", () => {
    const activity = createWorkspaceActivity(true);
    const view = renderSubscription(activity);

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    activity.set(false);
    activity.set(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
