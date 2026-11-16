import { describe, expect, it } from "vitest";
import {
  detectEditorLanguageId,
  getEditorLanguageLabel,
  isEditorLanguageId,
} from "./editor-language";

describe("detectEditorLanguageId", () => {
  it.each([
    ["src/file.ts", "typescript"],
    ["src/file.tsx", "typescriptreact"],
    ["src/file.mjs", "javascript"],
    ["README.md", "markdown"],
    ["Dockerfile.prod", "dockerfile"],
    [".env.local", "env"],
    ["environment.json", "json"],
    ["env.txt", "plaintext"],
    ["unknown.custom", "plaintext"],
  ] as const)("detects %s as %s", (filePath, expected) => {
    expect(detectEditorLanguageId(filePath)).toBe(expected);
  });
});

describe("editor language catalog", () => {
  it("provides syntax labels without coupling callers to extensions", () => {
    expect(getEditorLanguageLabel("typescriptreact")).toBe("TSX");
    expect(getEditorLanguageLabel("jsonc")).toBe("JSONC");
    expect(getEditorLanguageLabel("astro")).toBe("Astro");
    expect(getEditorLanguageLabel("dockerfile")).toBe("Dockerfile");
    expect(getEditorLanguageLabel("env")).toBe("Env");
  });

  it("validates persisted language ids", () => {
    expect(isEditorLanguageId("rust")).toBe(true);
    expect(isEditorLanguageId("made-up-language")).toBe(false);
  });
});
