import { QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import type { ScheduleDeleted } from "@/api/generated";
import { uiI18n } from "@/lib/i18n/ui";
import { act, createTestQueryClient, renderHook } from "@/test-utils";
import { useSchedules } from "./useSchedules";

const { deleteSchedule } = vi.hoisted(() => ({ deleteSchedule: vi.fn() }));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListSchedules: () => ({ data: [], isLoading: false }),
  useDeleteSchedule: () => ({ mutateAsync: deleteSchedule, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(async () => {
  await act(() => uiI18n.changeLanguage("en"));
  uiI18n.removeResourceBundle("fr", "ui");
  vi.clearAllMocks();
});

it("translates a pending mutation failure when it arrives and preserves its cause", async () => {
  const pending = Promise.withResolvers<ScheduleDeleted>();
  deleteSchedule.mockReturnValueOnce(pending.promise);
  const error = new Error("Database refused schedule #13");
  const queryClient = createTestQueryClient();
  const { result } = renderHook(() => useSchedules(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  const removal = result.current.remove(13);
  expect(deleteSchedule).toHaveBeenCalledWith({ id: 13 });

  uiI18n.addResourceBundle("fr", "ui", {
    schedule: { list: { mutations: { deleteFailed: "Suppression impossible : {{error}}" } } },
  });
  await act(() => uiI18n.changeLanguage("fr"));
  pending.reject(error);

  await expect(removal).rejects.toBe(error);
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    "Suppression impossible : Database refused schedule #13",
  );
});
