import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWebSocketSession } from "@/hooks/useWebSocketSession";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { useSideConversationSession } from "./useSideConversationSession";

vi.mock("@/hooks/useWebSocketSession", () => ({ useWebSocketSession: vi.fn() }));

const initSession = vi.fn();

beforeEach(() => {
  initSession.mockReset();
  vi.mocked(useWebSocketSession).mockReturnValue({
    initSession,
    isConnected: true,
    permissionMode: "bypassPermissions",
  } as unknown as ReturnType<typeof useWebSocketSession>);
  useWsSessionStore.setState({
    sessions: {
      [wsSessionIdFromFeature(4)]: { ...createSessionEntry(), persistedLoaded: true },
    },
  });
});

describe("useSideConversationSession", () => {
  it("joins a live side conversation in its own saved mode", () => {
    renderHook(() => useSideConversationSession(4, "/repo", true));
    expect(initSession).toHaveBeenCalledWith({
      cwd: "/repo",
      featureId: 4,
      permissionMode: "bypassPermissions",
    });
  });

  it("leaves a finished side conversation alone", () => {
    renderHook(() => useSideConversationSession(4, "/repo", false));
    expect(initSession).not.toHaveBeenCalled();
  });
});
