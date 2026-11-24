import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStartConversation } from "./useStartConversation";

interface MutationOptions {
  mutation: {
    onSuccess: (session: { id: number }, variables: { data: { project_id: number } }) => void;
    onError: (error: unknown) => void;
  };
}

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  navigateToConversation: vi.fn(),
  invalidate: vi.fn(async () => {}),
  toastError: vi.fn(),
  options: null as MutationOptions | null,
  mutate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/lib/featureUpdated", () => ({ invalidateFeatureLists: mocks.invalidate }));
vi.mock("@/lib/api-errors", () => ({ toastError: mocks.toastError }));
vi.mock("@/lib/conversation-route", () => ({
  navigateToConversation: mocks.navigateToConversation,
}));
vi.mock("@/api/generated", () => ({
  useCreateFeature: (options: MutationOptions) => {
    mocks.options = options;
    return { mutate: mocks.mutate, isPending: false };
  },
}));

describe("useStartConversation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a conversation in the project, then opens it", () => {
    const { result } = renderHook(() => useStartConversation());
    act(() => result.current.start(3));
    expect(mocks.mutate).toHaveBeenCalledWith({ data: { project_id: 3, type: "ws-session" } });

    mocks.options?.mutation.onSuccess({ id: 41 }, { data: { project_id: 3 } });
    expect(mocks.invalidate).toHaveBeenCalledWith({}, 3);
    // The project's path comes from the projects cache; the feature was just created.
    expect(mocks.navigateToConversation).toHaveBeenCalledWith(mocks.navigate, 3, 41, {
      featureKnown: true,
    });
  });

  it("reports a failure", () => {
    renderHook(() => useStartConversation());
    const error = new Error("nope");
    mocks.options?.mutation.onError(error);
    expect(mocks.toastError).toHaveBeenCalledWith(error, "Failed to create conversation");
  });
});
