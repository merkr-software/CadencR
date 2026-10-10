// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  buildUnifiedAgentPanelId,
  buildUnifiedAgentsRowLayoutKey,
  parseUnifiedAgentsRowHeights,
  parseUnifiedAgentsRowWidths,
} from "./UnifiedAgentsGrid";

describe("UnifiedAgentsGrid persistence helpers", () => {
  it("keys rows by columns and row index", () => {
    // Heights/widths persist per row *position*, not per row contents:
    // row 0 keeps its size whether or not the agents inside it change.
    const key = buildUnifiedAgentsRowLayoutKey(2, 0);

    expect(key).toBe("columns:2|row:0");
    expect(buildUnifiedAgentsRowLayoutKey(3, 0)).not.toBe(key);
    expect(buildUnifiedAgentsRowLayoutKey(2, 1)).not.toBe(key);
  });

  it("builds stable panel ids from persisted entity ids", () => {
    expect(buildUnifiedAgentPanelId(7, 11, 13)).toBe("agent-7-11-13");
  });

  it("parses and clamps stored row heights", () => {
    expect(
      parseUnifiedAgentsRowHeights({
        "columns:2|row:0": 100,
        "columns:2|row:1": 1300,
        invalid: "640",
        nan: Number.NaN,
      }),
    ).toEqual({
      "columns:2|row:0": 420,
      "columns:2|row:1": 1200,
    });
  });

  it("parses stored row width layouts and drops invalid sizes", () => {
    expect(
      parseUnifiedAgentsRowWidths({
        "columns:2|row:0": {
          "agent-1-2-101": 33.3,
          "agent-1-2-202": 66.7,
          "agent-1-2-303": 101,
        },
        "columns:2|row:1": {
          "agent-1-2-303": -1,
        },
        invalid: "not-a-layout",
      }),
    ).toEqual({
      "columns:2|row:0": {
        "agent-1-2-101": 33.3,
        "agent-1-2-202": 66.7,
      },
    });
  });
});
