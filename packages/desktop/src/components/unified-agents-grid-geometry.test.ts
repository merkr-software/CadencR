import { describe, expect, it } from "vitest";
import {
  defaultAgentRowHeight,
  effectiveAgentColumns,
} from "@/components/unified-agents-grid-geometry";

describe("effectiveAgentColumns", () => {
  it("drops columns rather than squeezing cards below their minimum width", () => {
    expect(effectiveAgentColumns(1000, 3, 8)).toBe(2);
    expect(effectiveAgentColumns(700, 6, 8)).toBe(1);
  });

  it("treats the stepper value as a maximum", () => {
    expect(effectiveAgentColumns(2400, 3, 8)).toBe(3);
  });

  it("never leaves an empty column for agents that don't exist", () => {
    expect(effectiveAgentColumns(2400, 4, 2)).toBe(2);
    expect(effectiveAgentColumns(2400, 4, 0)).toBe(1);
  });

  it("uses the maximum before the grid has been measured", () => {
    expect(effectiveAgentColumns(null, 3, 8)).toBe(3);
  });
});

describe("defaultAgentRowHeight", () => {
  it("fills the grid minus a peek of the next row, within bounds", () => {
    expect(defaultAgentRowHeight(700)).toBe(636);
    expect(defaultAgentRowHeight(300)).toBe(420);
    expect(defaultAgentRowHeight(2000)).toBe(760);
  });
});
