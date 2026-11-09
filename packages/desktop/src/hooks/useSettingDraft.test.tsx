// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AxiosRequestConfig } from "axios";
import { QueryClientProvider } from "@tanstack/react-query";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { act, createTestQueryClient, renderHook } from "@/test-utils";
import { useSetting } from "./useSetting";
import { useSettingDraft } from "./useSettingDraft";

const writes: { value: string; resolve: () => void; reject: (error: unknown) => void }[] = [];

vi.mock("@/api/client", () => ({
  customInstance: (config: AxiosRequestConfig) => {
    if (config.method?.toUpperCase() !== "PUT") return Promise.resolve({ value: "10" });
    const { value } = config.data as { value: string };
    return new Promise((resolve, reject) => {
      writes.push({ value, resolve: () => resolve({ value }), reject });
    });
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function wrapper() {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(getGetWorkspaceSettingQueryKey("tabs"), { value: "10" });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useSetting", () => {
  beforeEach(() => {
    writes.length = 0;
  });

  it("shows the confirmed value while a write is on its way, and says it's saving", async () => {
    const { result } = renderHook(() => useSetting("tabs"), { wrapper: wrapper() });
    act(() => void result.current.setValue("12"));
    await flush();
    expect(result.current.value).toBe("10");
    expect(result.current.isSaving).toBe(true);

    writes[0]!.resolve();
    await flush();
    expect(result.current.value).toBe("12");
    expect(result.current.isSaving).toBe(false);
  });
});

describe("useSettingDraft", () => {
  beforeEach(() => {
    writes.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the draft apart from the confirmed value until the debounced write lands", async () => {
    const { result } = renderHook(() => useSettingDraft("tabs", 300), { wrapper: wrapper() });
    act(() => result.current.setDraft("1"));
    act(() => result.current.setDraft("15"));
    expect(result.current.draft).toBe("15");
    expect(result.current.value).toBe("10");
    expect(result.current.isSaving).toBe(true);
    expect(writes).toHaveLength(0);

    act(() => vi.advanceTimersByTime(300));
    await flush();
    expect(writes.map((write) => write.value)).toEqual(["15"]);

    writes[0]!.resolve();
    await flush();
    expect(result.current.draft).toBeNull();
    expect(result.current.value).toBe("15");
    expect(result.current.isSaving).toBe(false);
  });

  it("drops the draft for the confirmed value when the write fails", async () => {
    const { result } = renderHook(() => useSettingDraft("tabs", 300), { wrapper: wrapper() });
    act(() => result.current.setDraft("15"));
    act(() => vi.advanceTimersByTime(300));
    await flush();

    writes[0]!.reject(new Error("service unavailable"));
    await flush();
    expect(result.current.draft).toBeNull();
    expect(result.current.value).toBe("10");
  });

  it("still saves the last draft when the field unmounts within the debounce", async () => {
    const { result, unmount } = renderHook(() => useSettingDraft("tabs", 300), {
      wrapper: wrapper(),
    });
    act(() => result.current.setDraft("20"));
    unmount();
    await flush();
    expect(writes.map((write) => write.value)).toEqual(["20"]);
  });
});
