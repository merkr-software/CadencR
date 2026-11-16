import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  invalidateSettingsDerivedQueries,
  scheduleSettingsInvalidation,
} from "./settingsInvalidation";

function makeClient(): { client: QueryClient; calls: () => number } {
  let calls = 0;
  const client = {
    invalidateQueries: () => {
      calls += 1;
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  return { client, calls: () => calls };
}

describe("scheduleSettingsInvalidation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("invalidates immediately on the leading edge", () => {
    const { client, calls } = makeClient();
    scheduleSettingsInvalidation(client);
    expect(calls()).toBe(1);
  });

  it("coalesces a burst into one leading + one trailing refetch", () => {
    const { client, calls } = makeClient();
    // A single save fans out into several events in quick succession.
    scheduleSettingsInvalidation(client); // leading — fires now
    scheduleSettingsInvalidation(client);
    scheduleSettingsInvalidation(client);
    expect(calls()).toBe(1);
    // The settle window flushes exactly one trailing refetch.
    vi.advanceTimersByTime(500);
    expect(calls()).toBe(2);
  });

  it("treats an event after the window as a fresh leading edge", () => {
    const { client, calls } = makeClient();
    scheduleSettingsInvalidation(client); // leading
    vi.advanceTimersByTime(500); // window closes, no trailing (single event)
    expect(calls()).toBe(1);
    scheduleSettingsInvalidation(client); // fresh leading — fires now
    expect(calls()).toBe(2);
  });
});

describe("invalidateSettingsDerivedQueries", () => {
  it("refreshes the resolved agent selection, which a prompt can move", async () => {
    const client = new QueryClient();
    client.setQueryData(["/api/agent-runtime/selection"], { selections: {} });
    client.setQueryData(["/api/lsp/resolve", { language_id: "custom", project_id: 3 }], {});
    client.setQueryData(["/api/lsp/servers"], {});
    client.setQueryData(["/api/git/status"], { clean: true });

    await invalidateSettingsDerivedQueries(client);

    expect(client.getQueryState(["/api/agent-runtime/selection"])?.isInvalidated).toBe(true);
    expect(
      client.getQueryState(["/api/lsp/resolve", { language_id: "custom", project_id: 3 }])
        ?.isInvalidated,
    ).toBe(true);
    expect(client.getQueryState(["/api/lsp/servers"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["/api/git/status"])?.isInvalidated).toBe(false);
  });
});
