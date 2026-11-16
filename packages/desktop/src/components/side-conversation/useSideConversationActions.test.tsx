// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { useUpdateFeatureStatus } from "@/api/generated";
import { useSideConversationStore } from "@/stores/side-conversation-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useSideConversationActions } from "./useSideConversationActions";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock(import("@/api/generated"), async (importOriginal) => ({
  ...(await importOriginal()),
  useUpdateFeatureStatus: vi.fn(),
}));

const updateStatus = vi.fn();
const conversation = { featureId: 4, sessionId: 9, projectId: 2, question: "why?" };

function actions(live = false) {
  return renderHook(() => useSideConversationActions(7, conversation, live)).result.current;
}

beforeEach(() => {
  localStorage.clear();
  navigate.mockReset();
  updateStatus.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(useUpdateFeatureStatus).mockReturnValue({
    mutateAsync: updateStatus,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateFeatureStatus>);
  useSideConversationStore.setState({ bySource: {} });
  useSideConversationStore.getState().add(7, conversation);
});

describe("useSideConversationActions", () => {
  it("keeps the side question as a thread: un-archived, forgotten, opened", async () => {
    updateStatus.mockResolvedValue({ success: true });
    const { keep } = actions();
    await act(() => keep());
    expect(updateStatus).toHaveBeenCalledWith({ id: 4, data: { status: "active" } });
    expect(useSideConversationStore.getState().bySource[7]).toEqual([]);
    expect(navigate).toHaveBeenCalled();
  });

  it("stays when keeping it fails, and says so", async () => {
    updateStatus.mockRejectedValue(new Error("boom"));
    const { keep } = actions();
    await act(() => keep());
    expect(toast.error).toHaveBeenCalled();
    expect(useSideConversationStore.getState().bySource[7]).toEqual([conversation]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stops a live side agent before closing, and leaves an idle one alone", () => {
    const interrupt = vi.fn();
    useWsSessionStore.setState({ interrupt });
    actions(false).close();
    expect(interrupt).not.toHaveBeenCalled();
    useSideConversationStore.getState().add(7, conversation);
    actions(true).close();
    expect(interrupt).toHaveBeenCalledWith("ws-feature-4");
    expect(useSideConversationStore.getState().bySource[7]).toEqual([]);
  });
});
