import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiosRequestConfig } from "axios";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { getWorkspaceSettingsQueryKey } from "@/api/settings";
import { createTestQueryClient } from "@/test-utils";
import { isSettingSaving, readConfirmedSetting, writeSetting } from "./setting-persistence";

interface PendingWrite {
  url: string;
  value: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const pending: PendingWrite[] = [];
const toastError = vi.fn();

vi.mock("@/api/client", () => ({
  customInstance: (config: AxiosRequestConfig) =>
    new Promise((resolve, reject) => {
      const { value } = config.data as { value: string };
      pending.push({
        url: config.url ?? "",
        value,
        resolve: () => resolve({ value }),
        reject,
      });
    }),
}));

vi.mock("sonner", () => ({ toast: { error: (message: string) => toastError(message) } }));

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function cached(queryClient: ReturnType<typeof createTestQueryClient>, key: string): unknown {
  return queryClient.getQueryData(getGetWorkspaceSettingQueryKey(key));
}

describe("writeSetting", () => {
  beforeEach(() => {
    pending.length = 0;
    toastError.mockClear();
  });

  it("moves the cache only once the backend confirms", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(getGetWorkspaceSettingQueryKey("k"), { value: "old" });
    queryClient.setQueryData(getWorkspaceSettingsQueryKey(), [{ key: "k", value: "old" }]);

    const write = writeSetting(queryClient, "k", "new");
    await settle();
    expect(pending).toHaveLength(1);
    expect(cached(queryClient, "k")).toEqual({ value: "old" });
    expect(isSettingSaving("k")).toBe(true);

    pending[0]!.resolve();
    await expect(write).resolves.toBe(true);
    expect(cached(queryClient, "k")).toEqual({ value: "new" });
    expect(queryClient.getQueryData(getWorkspaceSettingsQueryKey())).toEqual([
      { key: "k", value: "new" },
    ]);
    expect(isSettingSaving("k")).toBe(false);
  });

  it("keeps the confirmed value and says why when the write fails", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(getGetWorkspaceSettingQueryKey("k"), { value: "old" });

    const write = writeSetting(queryClient, "k", "new");
    await settle();
    pending[0]!.reject(new Error("service unavailable"));

    await expect(write).resolves.toBe(false);
    expect(cached(queryClient, "k")).toEqual({ value: "old" });
    expect(toastError).toHaveBeenCalledWith('Could not save setting "k": service unavailable');
    expect(isSettingSaving("k")).toBe(false);
  });

  it("sends writes to one key in order, each update from the value confirmed before it", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(getGetWorkspaceSettingQueryKey("ids"), { value: "[1]" });
    const add = (id: number) => (confirmed: string | null | undefined) =>
      JSON.stringify([...(JSON.parse(confirmed ?? "[]") as number[]), id]);

    const first = writeSetting(queryClient, "ids", add(2));
    const second = writeSetting(queryClient, "ids", add(3));
    await settle();
    expect(pending.map((write) => write.value)).toEqual(["[1,2]"]);

    pending[0]!.resolve();
    await first;
    await settle();
    expect(pending.map((write) => write.value)).toEqual(["[1,2]", "[1,2,3]"]);
    pending[1]!.resolve();
    await expect(second).resolves.toBe(true);
    expect(cached(queryClient, "ids")).toEqual({ value: "[1,2,3]" });
  });

  it("keeps the last confirmed value when a later write fails", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(getGetWorkspaceSettingQueryKey("k"), { value: "a" });

    const first = writeSetting(queryClient, "k", "b");
    const second = writeSetting(queryClient, "k", "c");
    await settle();
    pending[0]!.resolve();
    await first;
    await settle();
    pending[1]!.reject(new Error("boom"));

    await expect(second).resolves.toBe(false);
    expect(cached(queryClient, "k")).toEqual({ value: "b" });
  });

  it("sends nothing when the update has nothing to write", async () => {
    const queryClient = createTestQueryClient();
    await expect(writeSetting(queryClient, "k", () => null)).resolves.toBe(true);
    expect(pending).toHaveLength(0);
  });

  it("reads the confirmed value from the bulk list when the key has no query", () => {
    const queryClient = createTestQueryClient();
    expect(readConfirmedSetting(queryClient, "k")).toBeUndefined();
    queryClient.setQueryData(getWorkspaceSettingsQueryKey(), [{ key: "k", value: "bulk" }]);
    expect(readConfirmedSetting(queryClient, "k")).toBe("bulk");
    expect(readConfirmedSetting(queryClient, "other")).toBeNull();
  });
});
