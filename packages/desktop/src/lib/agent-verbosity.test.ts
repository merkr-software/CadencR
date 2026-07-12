import { describe, expect, it } from "vitest";
import {
  AGENT_VERBOSITY_MODES,
  AGENT_VERBOSITY_OPTIONS,
  DEFAULT_AGENT_VERBOSITY_MODE,
  isToolAutoCollapsible,
  parseAgentSummaryMode,
  parseAgentVerbosityMode,
  verbosityControlsCollapse,
} from "./agent-verbosity";

describe("agent verbosity modes", () => {
  it("exposes every mode in the option list", () => {
    expect(AGENT_VERBOSITY_OPTIONS.map((o) => o.value).sort()).toEqual(
      [...AGENT_VERBOSITY_MODES].sort(),
    );
  });

  it("falls back to the default when the persisted value is unknown", () => {
    expect(parseAgentVerbosityMode(null)).toBe(DEFAULT_AGENT_VERBOSITY_MODE);
    expect(parseAgentVerbosityMode(undefined)).toBe(DEFAULT_AGENT_VERBOSITY_MODE);
    expect(parseAgentVerbosityMode("nonsense")).toBe(DEFAULT_AGENT_VERBOSITY_MODE);
  });

  it("round-trips every known mode through parseAgentVerbosityMode", () => {
    for (const mode of AGENT_VERBOSITY_MODES) {
      expect(parseAgentVerbosityMode(mode)).toBe(mode);
    }
  });
});

describe("verbosityControlsCollapse", () => {
  it("returns true for the two modes that drive controlled folds", () => {
    expect(verbosityControlsCollapse("auto_collapse")).toBe(true);
    expect(verbosityControlsCollapse("collapsed")).toBe(true);
  });

  it("returns false for modes that leave blocks uncontrolled", () => {
    expect(verbosityControlsCollapse("maximal")).toBe(false);
    expect(verbosityControlsCollapse("compact")).toBe(false);
  });
});

describe("parseAgentSummaryMode", () => {
  it("defaults to false when unset or not the literal 'true'", () => {
    expect(parseAgentSummaryMode(null)).toBe(false);
    expect(parseAgentSummaryMode(undefined)).toBe(false);
    expect(parseAgentSummaryMode("false")).toBe(false);
    expect(parseAgentSummaryMode("nonsense")).toBe(false);
  });

  it("is true only for the literal 'true'", () => {
    expect(parseAgentSummaryMode("true")).toBe(true);
  });
});

describe("isToolAutoCollapsible", () => {
  it("covers Bash and the file-change tools", () => {
    expect(isToolAutoCollapsible("Bash")).toBe(true);
    expect(isToolAutoCollapsible("Edit")).toBe(true);
    expect(isToolAutoCollapsible("Write")).toBe(true);
  });

  it("does not collapse Read/Grep/unknown tools", () => {
    expect(isToolAutoCollapsible("Read")).toBe(false);
    expect(isToolAutoCollapsible("Grep")).toBe(false);
    expect(isToolAutoCollapsible(undefined)).toBe(false);
  });
});
