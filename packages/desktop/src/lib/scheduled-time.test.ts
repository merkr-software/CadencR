import { describe, expect, it } from "vitest";
import { nextCountdownDelay, SCHEDULE_PRESETS } from "./scheduled-time";

describe("scheduled-time", () => {
  it("'In 1 hour' preset resolves ~60 minutes ahead", () => {
    const now = new Date(2026, 5, 21, 15, 30, 0, 0);
    const preset = SCHEDULE_PRESETS.find((p) => p.label === "In 1 hour")!;
    expect(preset.resolve(now).getTime() - now.getTime()).toBe(60 * 60_000);
  });

  it("'Tomorrow 9 AM' rolls forward when 9am already passed today", () => {
    const afternoon = new Date(2026, 5, 21, 15, 0, 0, 0);
    const preset = SCHEDULE_PRESETS.find((p) => p.label === "Tomorrow 9 AM")!;
    const resolved = preset.resolve(afternoon);
    expect(resolved.getDate()).toBe(22);
    expect(resolved.getHours()).toBe(9);
  });

  it("'This evening' stays today when 6pm is still ahead", () => {
    const morning = new Date(2026, 5, 21, 9, 0, 0, 0);
    const preset = SCHEDULE_PRESETS.find((p) => p.label === "This evening")!;
    const resolved = preset.resolve(morning);
    expect(resolved.getDate()).toBe(21);
    expect(resolved.getHours()).toBe(18);
  });

  describe("nextCountdownDelay", () => {
    it("ticks every second inside the final minute", () => {
      expect(nextCountdownDelay(60_000)).toBe(1_000);
      expect(nextCountdownDelay(30_000)).toBe(1_000);
      expect(nextCountdownDelay(0)).toBe(1_000);
    });

    it("relaxes to 30s when more than a minute out", () => {
      expect(nextCountdownDelay(60_001)).toBe(30_000);
      expect(nextCountdownDelay(5 * 60_000)).toBe(30_000);
    });

    it("keeps ticking for the first second past due, then stops", () => {
      expect(nextCountdownDelay(-500)).toBe(1_000);
      expect(nextCountdownDelay(-1_000)).toBeNull();
      expect(nextCountdownDelay(-5_000)).toBeNull();
    });
  });
});
