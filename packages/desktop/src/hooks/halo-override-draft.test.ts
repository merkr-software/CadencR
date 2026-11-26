import { QueryObserver, type QueryClient } from "@tanstack/react-query";
import type { AxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { customInstance } from "@/api/client";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { createTestQueryClient } from "@/test-utils";
import {
  DEFAULT_HALO_OVERRIDE,
  parseHaloOverrides,
  THEME_HALO_OVERRIDES_SETTING_KEY,
} from "@/lib/themes";
import { haloOverrideDraft } from "./halo-override-draft";

interface PendingWrite {
  value: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingRead {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const writes: PendingWrite[] = [];
const reads: PendingRead[] = [];
const toastError = vi.fn();
const clients: QueryClient[] = [];
const unsubscribes: (() => void)[] = [];
let serverValue: string | null = null;
let holdReads = false;
let readError: Error | null = null;

// Only the HTTP boundary is replaced: the setting reader, the serialized writer
// and the shared draft all run as they do in the app.
vi.mock("@/api/client", () => ({
  customInstance: (config: AxiosRequestConfig) => {
    if (config.method === "GET") {
      if (readError) return Promise.reject(readError);
      const value = serverValue;
      if (!holdReads) return Promise.resolve({ value });
      return new Promise((resolve, reject) => {
        reads.push({ resolve: () => resolve({ value }), reject });
      });
    }
    return new Promise((resolve, reject) => {
      const { value } = config.data as { value: string };
      writes.push({ value, resolve: () => resolve({ value }), reject });
    });
  },
}));

vi.mock("sonner", () => ({ toast: { error: (message: string) => toastError(message) } }));

const queryKey = getGetWorkspaceSettingQueryKey(THEME_HALO_OVERRIDES_SETTING_KEY);

async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** A mounted reader, so the setting query is observed exactly as in the app. */
async function setup(initial: Record<string, unknown> | null) {
  serverValue = initial === null ? null : JSON.stringify(initial);
  const queryClient = createTestQueryClient();
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: () =>
      customInstance<{ value: string | null }>({
        method: "GET",
        url: `/api/workspace/settings/${THEME_HALO_OVERRIDES_SETTING_KEY}`,
      }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  unsubscribes.push(observer.subscribe(() => {}));
  clients.push(queryClient);
  await tick();
  return { queryClient, store: haloOverrideDraft(queryClient) };
}

function written(index: number) {
  return parseHaloOverrides(writes[index]!.value).value;
}

describe("haloOverrideDraft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writes.length = 0;
    reads.length = 0;
    holdReads = false;
    readError = null;
    toastError.mockClear();
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    for (const client of clients.splice(0)) client.clear();
    vi.useRealTimers();
  });

  it("holds the next map update until the failed write's read lands", async () => {
    const { store } = await setup({ "frost-dark": { intensity: 1.25 } });

    store.setDraft("frost-dark", { ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 });
    await tick(150);
    expect(writes).toHaveLength(1);

    // The backend committed the write; only its response failed.
    serverValue = writes[0]!.value;
    holdReads = true;
    writes[0]!.reject(new Error("service unavailable"));
    await tick();
    expect(reads).toHaveLength(1);

    store.setDraft("frost-light", { ...DEFAULT_HALO_OVERRIDE, rotation: 45 });
    await tick(150);
    expect(writes).toHaveLength(1);

    reads[0]!.resolve();
    await tick();
    expect(writes).toHaveLength(2);
    expect(written(1)).toEqual({
      "frost-dark": expect.objectContaining({ intensity: 1.5 }),
      "frost-light": expect.objectContaining({ rotation: 45 }),
    });
  });

  it("keeps the next map update back when the failed write's read fails", async () => {
    const { store } = await setup({ "frost-dark": { intensity: 1.25 } });

    store.setDraft("frost-dark", { ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 });
    await tick(150);
    serverValue = writes[0]!.value;
    readError = new Error("service unavailable");
    writes[0]!.reject(new Error("service unavailable"));
    await tick();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Could not reload setting"));

    store.setDraft("frost-light", { ...DEFAULT_HALO_OVERRIDE, rotation: 45 });
    await tick(150);
    expect(writes).toHaveLength(1);

    // Only a successful read lets the next update merge and send again.
    readError = null;
    store.setDraft("frost-light", { ...DEFAULT_HALO_OVERRIDE, rotation: 90 });
    await tick(150);
    expect(writes).toHaveLength(2);
    expect(written(1)).toEqual({
      "frost-dark": expect.objectContaining({ intensity: 1.5 }),
      "frost-light": expect.objectContaining({ rotation: 90 }),
    });
  });

  it("does not let an older settings read replace the reconciled halo map", async () => {
    const { queryClient, store } = await setup({ "frost-dark": { intensity: 1.25 } });
    holdReads = true;
    const previousRead = queryClient.refetchQueries({ queryKey, exact: true });
    await tick();
    expect(reads).toHaveLength(1);

    store.setDraft("frost-dark", { ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 });
    await tick(150);
    serverValue = writes[0]!.value;
    writes[0]!.reject(new Error("response lost"));
    await tick();
    expect(reads).toHaveLength(2);
    reads[1]!.resolve();
    await tick();
    expect(queryClient.getQueryData(queryKey)).toEqual({ value: serverValue });

    reads[0]!.resolve();
    await previousRead;
    store.setDraft("frost-light", { ...DEFAULT_HALO_OVERRIDE, rotation: 45 });
    await tick(150);

    expect(written(1)).toEqual({
      "frost-dark": expect.objectContaining({ intensity: 1.5 }),
      "frost-light": expect.objectContaining({ rotation: 45 }),
    });
  });
});
