import { describe, expect, it } from "vitest";
import {
  CONTEXT_METER_DISPLAYS,
  type ContextMeterDisplay,
  nextContextMeterDisplay,
  parseContextMeterDisplay,
} from "./context-meter-display";

describe("context meter display", () => {
  it("defaults to bar and percentage for unset or unknown values", () => {
    expect(parseContextMeterDisplay(null)).toBe("bar_percent");
    expect(parseContextMeterDisplay("sparkline")).toBe("bar_percent");
    expect(parseContextMeterDisplay("tokens")).toBe("tokens");
  });

  it("cycles through every display and wraps around", () => {
    const seen: ContextMeterDisplay[] = [CONTEXT_METER_DISPLAYS[0]];
    for (let step = 1; step < CONTEXT_METER_DISPLAYS.length; step++) {
      seen.push(nextContextMeterDisplay(seen[step - 1]));
    }
    expect(seen).toEqual([...CONTEXT_METER_DISPLAYS]);
    expect(nextContextMeterDisplay(seen[seen.length - 1])).toBe(CONTEXT_METER_DISPLAYS[0]);
  });
});
