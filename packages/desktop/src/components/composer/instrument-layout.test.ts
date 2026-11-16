import { describe, expect, it } from "vitest";
import { chooseSplit, singleRowWidth, zoneSlots, type InstrumentWidths } from "./instrument-layout";

// autoscroll │ mode │ model · effort │ access ··· meter, history, ⋯, attach + Send
const WIDTHS: InstrumentWidths = {
  autoscroll: 28,
  mode: 90,
  model: 220,
  access: 80,
  compaction: 0,
  meter: 70,
  todos: 0,
  history: 28,
  assist: 28,
  "stop-arm": 0,
  actions: 60,
};
const spacing = (available: number) => ({
  available,
  compactBelow: 0,
  rowGap: 6,
  sessionGap: 11,
  trailingGap: 6,
});
// 28+90+220+80 + 3×11 = 451; 70+28+28+60 + 3×6 = 204; + 6 = 661.
const SINGLE_WIDTH = 661;

describe("zoneSlots", () => {
  it("lifts mode, model and access into the header, nothing else", () => {
    expect(zoneSlots(true)).toEqual({
      topLeft: ["mode", "model"],
      topRight: ["access"],
      bottomLeft: ["autoscroll"],
      bottomRight: ["compaction", "meter", "todos", "history", "assist", "stop-arm", "actions"],
    });
  });

  it("never moves the read-outs, tools or run controls off the bottom right", () => {
    expect(zoneSlots(true).bottomRight).toEqual(zoneSlots(false).bottomRight);
  });
});

describe("chooseSplit", () => {
  it("measures one row with gaps only between shown instruments", () => {
    expect(singleRowWidth(WIDTHS, spacing(0))).toBe(SINGLE_WIDTH);
  });

  it("keeps one row while every instrument fits", () => {
    expect(chooseSplit(false, WIDTHS, spacing(SINGLE_WIDTH + 1))).toBe(false);
  });

  it("splits as soon as one row overflows", () => {
    expect(chooseSplit(false, WIDTHS, spacing(SINGLE_WIDTH - 1))).toBe(true);
  });

  it("stays split below the width where labels compact", () => {
    const narrowLabels = { ...spacing(SINGLE_WIDTH + 50), compactBelow: SINGLE_WIDTH + 100 };
    expect(chooseSplit(false, WIDTHS, narrowLabels)).toBe(true);
  });

  it("folds back to one row only with room to spare", () => {
    expect(chooseSplit(true, WIDTHS, spacing(SINGLE_WIDTH + 2))).toBe(true);
    expect(chooseSplit(true, WIDTHS, spacing(SINGLE_WIDTH + 8))).toBe(false);
  });

  it("never opens an empty header", () => {
    const noSession = { ...WIDTHS, mode: 0, model: 0, access: 0 };
    expect(chooseSplit(false, noSession, spacing(100))).toBe(false);
  });
});
