import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, type ReactNode } from "react";
import { act, renderHook } from "@/test-utils";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { AgentPromptBarHandle } from "../AgentPromptBar";
import { useAgentSessionBranchEffects } from "./useAgentSessionBranchEffects";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), navigateToFeature: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/lib/conversation-route", () => ({
  navigateToConversation: mocks.navigateToFeature,
}));

const SESSION_ID = "ws-feature-3";

function renderInWorkspace(activity: WorkspaceActivityController) {
  const promptBarRef = createRef<AgentPromptBarHandle>();
  return renderHook(() => useAgentSessionBranchEffects(SESSION_ID, promptBarRef), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
    ),
  });
}

describe("navigation to a fork that just completed", () => {
  beforeEach(() => {
    mocks.navigateToFeature.mockClear();
    useWsSessionStore.setState({
      forkNavigation: { sessionId: SESSION_ID, projectId: 2, featureId: 9, nonce: 1 },
    });
  });

  afterEach(() => useWsSessionStore.setState({ forkNavigation: null }));

  it("happens at once in the conversation on screen", () => {
    renderInWorkspace(createWorkspaceActivity(true));

    // The service just created it: no detour through the legacy feature page.
    expect(mocks.navigateToFeature).toHaveBeenCalledWith(mocks.navigate, 2, 9, {
      featureKnown: true,
    });
    expect(useWsSessionStore.getState().forkNavigation).toBeNull();
  });

  it("waits while its conversation is hidden, then happens when it is shown", () => {
    const activity = createWorkspaceActivity(false);
    renderInWorkspace(activity);

    expect(mocks.navigateToFeature).not.toHaveBeenCalled();
    expect(useWsSessionStore.getState().forkNavigation).not.toBeNull();

    act(() => activity.set(true));

    expect(mocks.navigateToFeature).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToFeature).toHaveBeenCalledWith(mocks.navigate, 2, 9, {
      featureKnown: true,
    });
    expect(useWsSessionStore.getState().forkNavigation).toBeNull();
  });

  it("is dropped, not made, when its workspace goes while it waits", () => {
    const view = renderInWorkspace(createWorkspaceActivity(false));

    view.unmount();

    expect(mocks.navigateToFeature).not.toHaveBeenCalled();
    expect(useWsSessionStore.getState().forkNavigation).toBeNull();
  });

  it("leaves another conversation's pending navigation alone", () => {
    useWsSessionStore.setState({
      forkNavigation: { sessionId: "ws-feature-8", projectId: 2, featureId: 9, nonce: 1 },
    });
    const view = renderInWorkspace(createWorkspaceActivity(false));

    view.unmount();

    expect(useWsSessionStore.getState().forkNavigation?.sessionId).toBe("ws-feature-8");
  });
});
