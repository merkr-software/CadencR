import { afterEach, describe, expect, it, vi } from "vitest";
import { observeServerClock, resetServerClock, serverToLocalMs } from "./server-clock";

describe("server clock", () => {
  afterEach(() => {
    resetServerClock();
    vi.useRealTimers();
  });

  it("converts server instants with the least-delayed sample", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    // Server 2s ahead, but this sample spent 300ms in transit.
    observeServerClock(11_700);
    expect(serverToLocalMs(20_000)).toBe(18_300);

    observeServerClock(12_000);
    expect(serverToLocalMs(20_000)).toBe(18_000);
    // Slower samples, and gains too small to re-anchor timers for, are ignored.
    observeServerClock(11_000);
    observeServerClock(12_010);
    expect(serverToLocalMs(20_000)).toBe(18_000);
  });

  it("starts over on a new connection and ignores malformed stamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    observeServerClock(12_000);
    resetServerClock();
    observeServerClock(9_000);
    expect(serverToLocalMs(20_000)).toBe(21_000);

    observeServerClock("soon");
    observeServerClock(Number.NaN);
    expect(serverToLocalMs(20_000)).toBe(21_000);
  });
});
