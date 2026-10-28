import { afterEach, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils";
import { toast } from "sonner";
import { getManagedThemes } from "@/api/generated";
import { ManagedThemeRegistry, useManagedThemes } from "./useManagedThemes";

vi.mock("@/api/generated", () => ({ getManagedThemes: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
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

it("loads installed themes once at the root and reports a failure with a stable toast id", async () => {
  vi.mocked(getManagedThemes).mockRejectedValue(new Error("inventory broke"));
  const client = createTestQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <ManagedThemeRegistry />
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  expect(vi.mocked(toast.error).mock.calls[0]?.[1]).toEqual({ id: "managed-themes-load" });
  view.unmount();
  client.clear();
});
