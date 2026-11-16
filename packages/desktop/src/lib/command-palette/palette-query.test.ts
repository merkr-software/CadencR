import { describe, expect, it } from "vitest";
import { applyPaletteInput, nextScope } from "./palette-query";
import { frecencyWeight, readFrecency, recordPick } from "./palette-frecency";

describe("applyPaletteInput", () => {
  it("turns a leading prefix into a mode", () => {
    expect(applyPaletteInput("all", ">git")).toEqual({ mode: "commands", text: "git" });
    expect(applyPaletteInput("all", "@ src/main")).toEqual({ mode: "files", text: "src/main" });
    expect(applyPaletteInput("all", "#deploy")).toEqual({ mode: "messages", text: "deploy" });
  });

  it("keeps the text as typed once a mode is set", () => {
    expect(applyPaletteInput("files", "#hash.ts")).toEqual({ mode: "files", text: "#hash.ts" });
    expect(applyPaletteInput("all", "fix #250")).toEqual({ mode: "all", text: "fix #250" });
  });
});

describe("nextScope", () => {
  it("skips the project scope when no project is open", () => {
    expect(nextScope("all", true)).toBe("project");
    expect(nextScope("all", false)).toBe("active");
    expect(nextScope("active", false)).toBe("all");
  });
});

describe("palette frecency", () => {
  const day = 24 * 60 * 60 * 1000;

  it("weighs repeated and recent picks higher", () => {
    let map = recordPick({}, "conv:1", 0);
    map = recordPick(map, "conv:1", 0);
    map = recordPick(map, "conv:2", 0);
    expect(frecencyWeight(map["conv:1"], 0)).toBeGreaterThan(frecencyWeight(map["conv:2"], 0));
    expect(frecencyWeight(map["conv:1"], 6 * day)).toBeLessThan(frecencyWeight(map["conv:1"], 0));
    expect(frecencyWeight(undefined, 0)).toBe(0);
  });

  it("reports corrupt storage instead of trusting it", () => {
    expect(readFrecency({ getItem: () => "{not json" }).error).toBeTruthy();
    expect(readFrecency({ getItem: () => '{"a":{"count":"x"}}' }).error).toBeTruthy();
    expect(readFrecency({ getItem: () => '{"a":{"count":1,"at":5}}' })).toEqual({
      map: { a: { count: 1, at: 5 } },
      error: null,
    });
  });
});
