import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook } from "@/test-utils";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useFileWatcher } from "./useFileWatcher";

function renderWatcher(activity: WorkspaceActivityController) {
  return renderHook(() => useFileWatcher(1, 7), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
    ),
  });
}

describe("file watcher of a workspace kept mounted but hidden", () => {
  const subscribe = vi.fn();

  beforeEach(() => {
    subscribe.mockClear();
    useSessionStatusStore.setState({ isConnected: true, subscribeFileWatcher: subscribe });
  });

  it("is not taken by a workspace mounted hidden", () => {
    renderWatcher(createWorkspaceActivity(false));
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("is taken again each time its workspace is shown", () => {
    const activity = createWorkspaceActivity(true);
    renderWatcher(activity);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenLastCalledWith(1, 7);

    // Another editor took it while this one was hidden.
    activity.set(false);
    expect(subscribe).toHaveBeenCalledTimes(1);

    activity.set(true);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenLastCalledWith(1, 7);
  });

  it("follows its workspace no more once unmounted", () => {
    const activity = createWorkspaceActivity(true);
    const view = renderWatcher(activity);
    view.unmount();

    activity.set(false);
    activity.set(true);

    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
