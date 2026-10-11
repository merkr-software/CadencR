import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils";
import { getManagedThemes } from "@/api/generated";
import { useManagedThemes } from "./useManagedThemes";

vi.mock("@/api/generated", () => ({ getManagedThemes: vi.fn() }));
afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("rechecks policy through inventory within fifteen minutes even without focus or interaction", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(false);
  vi.mocked(getManagedThemes).mockResolvedValue([]);
  const client = createTestQueryClient();
  const hook = renderHook(() => useManagedThemes(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(getManagedThemes).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(15 * 60_000 - 2));
  expect(getManagedThemes).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(getManagedThemes).toHaveBeenCalledTimes(2);
  hook.unmount();
  await act(() => vi.advanceTimersByTimeAsync(15 * 60_000));
  expect(getManagedThemes).toHaveBeenCalledTimes(2);
  client.clear();
});
