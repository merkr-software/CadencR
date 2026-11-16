import { describe, expect, it } from "vitest";

import {
  declaredReplacements,
  NO_TAB_REPLACEMENTS,
  parseTabReplacements,
  replacedBy,
  serializeTabReplacements,
  withTabReplacement,
} from "./tab-replacements";

describe("parseTabReplacements", () => {
  it("reads replaceable built-ins mapped to distinct tab ids", () => {
    expect(parseTabReplacements('{"git":"my-vcs","editor":"ide"}')).toEqual({
      git: "my-vcs",
      editor: "ide",
    });
  });

  it("treats unset or malformed values as no replacement", () => {
    for (const value of [
      null,
      undefined,
      "",
      "not json",
      "[]",
      '{"agent":"a"}',
      '{"browser":"a"}',
      '{"git":"Bad Id"}',
      '{"git":"a","terminal":"a"}',
    ]) {
      expect(parseTabReplacements(value)).toBe(NO_TAB_REPLACEMENTS);
    }
  });
});

describe("withTabReplacement", () => {
  it("sets and clears one built-in", () => {
    const chosen = withTabReplacement({}, "git", "my-vcs");
    expect(chosen).toEqual({ git: "my-vcs" });
    expect(withTabReplacement(chosen, "git", null)).toEqual({});
  });

  it("moves a tab that already replaces another built-in", () => {
    expect(withTabReplacement({ git: "ide", terminal: "sh" }, "editor", "ide")).toEqual({
      editor: "ide",
      terminal: "sh",
    });
  });

  it("serializes in strip order, so equal choices compare equal", () => {
    expect(serializeTabReplacements({ preview: "docs", terminal: "sh" })).toBe(
      '{"terminal":"sh","preview":"docs"}',
    );
    expect(parseTabReplacements(serializeTabReplacements({ git: "a" }))).toEqual({ git: "a" });
  });
});

describe("helpers", () => {
  it("finds what a tab replaces and keeps only replaceable declarations", () => {
    expect(replacedBy({ git: "a" }, "a")).toBe("git");
    expect(replacedBy({ git: "a" }, "b")).toBeNull();
    expect(declaredReplacements(["editor", "agent", "git"])).toEqual(["git", "editor"]);
  });
});
