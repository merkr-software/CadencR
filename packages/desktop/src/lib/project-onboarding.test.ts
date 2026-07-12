import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useNewProjectOnboarding } from "./project-onboarding";

// Control the dismissed flag at the settings-storage boundary so the real
// `useProjectOnboardingDismissed` → `useNewProjectOnboarding` chain runs, and
// the test targets the gating logic rather than the query/mutation plumbing.
const settingState = { value: null as string | null };
const mockSetValue = vi.fn();
vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: () => ({
    value: settingState.value,
    setValue: mockSetValue,
    isLoading: false,
  }),
}));

describe("useNewProjectOnboarding", () => {
  beforeEach(() => {
    settingState.value = null; // unset → not dismissed
    mockSetValue.mockReset();
  });

  it("opens the modal for a created project when not dismissed", () => {
    const { result } = renderHook(() => useNewProjectOnboarding());
    expect(result.current.onboardingProject).toBeNull();

    act(() => result.current.maybeOnboard({ id: 7, name: "acme" }));
    expect(result.current.onboardingProject).toEqual({ id: 7, name: "acme" });
  });

  it("does not open the modal when dismissed for good", () => {
    settingState.value = "true";
    const { result } = renderHook(() => useNewProjectOnboarding());

    act(() => result.current.maybeOnboard({ id: 7, name: "acme" }));
    expect(result.current.onboardingProject).toBeNull();
  });

  it("close() clears the open project", () => {
    const { result } = renderHook(() => useNewProjectOnboarding());
    act(() => result.current.maybeOnboard({ id: 7, name: "acme" }));
    expect(result.current.onboardingProject).not.toBeNull();

    act(() => result.current.close());
    expect(result.current.onboardingProject).toBeNull();
  });

  it("reads the dismissed flag freshly on each maybeOnboard (ref, not stale closure)", () => {
    const { result, rerender } = renderHook(() => useNewProjectOnboarding());

    // User toggles "Don't show this again" after the hook first mounted.
    settingState.value = "true";
    rerender();

    act(() => result.current.maybeOnboard({ id: 9, name: "beta" }));
    expect(result.current.onboardingProject).toBeNull();
  });
});
