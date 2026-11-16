// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const store = new Map<IDBValidKey, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: IDBValidKey) => store.get(key)),
  set: vi.fn(async (key: IDBValidKey, value: unknown) => {
    store.set(key, value);
  }),
}));

// Re-import after mock is registered.
import { readAgentStateCache, writeAgentStateCache } from "./agentStateCache";
import type { FeatureAgentStateResponse } from "@/api/generated";

const sampleResponse: FeatureAgentStateResponse = { sessions: [] };

function ensureIndexedDB(): void {
  if (typeof globalThis.indexedDB === "undefined") {
    Object.defineProperty(globalThis, "indexedDB", { value: {}, configurable: true });
  }
}

describe("agentStateCache", () => {
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers();
    ensureIndexedDB();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when nothing is cached", async () => {
    const result = await readAgentStateCache(123);
    expect(result).toBeNull();
  });

  it("throttles writes per feature: latest value wins inside the window", async () => {
    const first: FeatureAgentStateResponse = { sessions: [{ sessionDbId: 1 } as never] };
    const second: FeatureAgentStateResponse = { sessions: [{ sessionDbId: 2 } as never] };

    await writeAgentStateCache(42, first);
    await writeAgentStateCache(42, second);

    expect(store.size).toBe(0);

    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.size).toBe(1);
    const cached = store.get("cadencr-agent-state-v1:42");
    expect(cached).toEqual(second);
  });

  it("round-trips a cached value across read/write", async () => {
    await writeAgentStateCache(7, sampleResponse);
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    const result = await readAgentStateCache(7);
    expect(result).toEqual(sampleResponse);
  });
});
