import { describe, expect, it } from "vitest";
import { managedThemeEntrySchema, duplicateThemeResponseSchema } from "./theme-marketplace";
import { DRACULA_THEME } from "./themes/dracula";

const theme = {
  id: "managed:midnight",
  path: "/themes/midnight/theme.json",
  content: "{}",
  assets: {},
  issues: [],
  theme: { label: "Midnight", appearance: "dark", cssVars: {}, xterm: DRACULA_THEME.xterm },
};
const entry = {
  id: "midnight",
  name: "Midnight",
  version: "1.0.0",
  sha256: "a".repeat(64),
  active: false,
  theme,
};

describe("managed theme response boundaries", () => {
  it("preserves optional offline policy warnings at managed boundaries", () => {
    const warning = "Remote policy unavailable; cached policy used.";
    expect(managedThemeEntrySchema.parse({ ...entry, warning }).warning).toBe(warning);
    expect(
      duplicateThemeResponseSchema.parse({
        theme: { ...theme, id: "copy" },
        workspace: { project_id: 1, feature_id: 2, cwd: "/copy", created: true },
        warning,
      }).warning,
    ).toBe(warning);
    expect(managedThemeEntrySchema.safeParse({ ...entry, warning: 3 }).success).toBe(false);
  });

  it("preserves a diagnostic row without accepting an empty digest for a valid theme", () => {
    expect(
      managedThemeEntrySchema.safeParse({
        ...entry,
        theme: null,
        sha256: "",
        error: "Missing revision",
        error_code: "THEME_NOT_FOUND",
      }).success,
    ).toBe(true);
    expect(managedThemeEntrySchema.safeParse({ ...entry, sha256: "" }).success).toBe(false);
    expect(managedThemeEntrySchema.safeParse({ ...entry, theme: null }).success).toBe(false);
  });
  it("requires the full terminal palette before rendering a valid theme", () => {
    expect(managedThemeEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      managedThemeEntrySchema.safeParse({
        ...entry,
        theme: { ...theme, theme: { ...theme.theme, xterm: {} } },
      }).success,
    ).toBe(false);
  });
  it("validates the author document and full workspace in duplication responses", () => {
    expect(
      duplicateThemeResponseSchema.safeParse({
        theme: { ...theme, id: "midnight-copy" },
        workspace: { project_id: 1, feature_id: 2, cwd: "/themes/copy", created: true },
      }).success,
    ).toBe(true);
    expect(
      duplicateThemeResponseSchema.safeParse({
        theme: { id: "copy", path: "/copy" },
        workspace: { project_id: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("theme label Rust parity", () => {
  const parse = (label: string) =>
    managedThemeEntrySchema.safeParse({
      ...entry,
      theme: { ...theme, theme: { ...theme.theme, label } },
    });
  it.each(["😀".repeat(64), "  Midnight  ", "\u0085Midnight\u0085", "\uFEFF"])(
    "accepts scalar-counted labels without altering signed fields: %s",
    (label) => {
      const result = parse(label);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.theme?.theme?.label).toBe(label);
    },
  );
  it.each(["", " \t\n", "\u0085", "\u2000\u3000", "😀".repeat(65), "a".repeat(65), "\ud800"])(
    "rejects invalid or overlong labels: %s",
    (label) => {
      expect(parse(label).success).toBe(false);
    },
  );
  it("checks trimmed bounds rather than padded document length", () => {
    expect(parse(" ".repeat(100) + "a".repeat(64) + " ".repeat(100)).success).toBe(true);
    expect(parse(" ".repeat(100) + "a".repeat(65)).success).toBe(false);
  });
});
