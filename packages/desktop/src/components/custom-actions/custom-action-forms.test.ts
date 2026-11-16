import { describe, expect, it } from "vitest";

import { actionMonogram, lucideIconFor, lucideIconValue } from "./action-icons";
import { moveId } from "./CustomActionsManager";
import { detectVariables, validateCustomActionForm } from "./useCustomActionEditorForm";

describe("action editor form", () => {
  it("detects variables in declaration order, once each", () => {
    expect(detectVariables("echo ${A} ${B} ${A} $NOT ${1bad}")).toEqual(["A", "B"]);
  });

  it("requires a name and a command", () => {
    const form = {
      name: " ",
      command: "",
      scope: "project" as const,
      iconData: null,
      runInTerminal: false,
    };
    expect(validateCustomActionForm(form)).toEqual({
      name: "Give the action a name.",
      command: "Enter the command to run.",
    });
    expect(validateCustomActionForm({ ...form, name: "Lint", command: "pnpm lint" })).toEqual({});
  });
});

describe("action icons", () => {
  it("round-trips a shipped glyph and ignores unknown ones", () => {
    expect(lucideIconFor(lucideIconValue("deploy"))).not.toBeNull();
    expect(lucideIconFor("lucide:nope")).toBeNull();
    expect(lucideIconFor("data:image/png;base64,xx")).toBeNull();
  });

  it("derives a monogram from the name", () => {
    expect(actionMonogram("Run tests")).toBe("RT");
    expect(actionMonogram("lint")).toBe("LI");
    expect(actionMonogram("db:migrate")).toBe("DM");
    expect(actionMonogram("  ")).toBe("?");
  });
});

describe("moveId", () => {
  it("moves an action to a new index, keeping the others in order", () => {
    expect(moveId([1, 2, 3, 4], 4, 0)).toEqual([4, 1, 2, 3]);
    expect(moveId([1, 2, 3, 4], 1, 2)).toEqual([2, 3, 1, 4]);
    expect(moveId([1, 2, 3], 2, 99)).toEqual([1, 3, 2]);
  });
});
