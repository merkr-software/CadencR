import { describe, expect, it } from "vitest";
import { pluginTabSummary } from "@/components/plugin-tabs/plugin-tab-fixtures";
import { resolveEditorId, resolveEditorTarget } from "./editor-registry";

const editor = pluginTabSummary({
  id: "example-editor",
  editor: { label: "Example editor", open_method: "files.open" },
  backend: {
    protocol: 2,
    binary: { "darwin-aarch64": "bin/editor", "linux-x86_64": "bin/editor" },
    reasoning: "Edit files.",
  },
});

describe("editor selection", () => {
  it("preserves the legacy selection only while editor_backend is absent", () => {
    expect(resolveEditorId(null, "2")).toBe("neovim");
    expect(resolveEditorId(undefined, "1")).toBe("codemirror");
    expect(resolveEditorId("codemirror", "2")).toBe("codemirror");
    expect(resolveEditorId("plugin:example-editor", "0")).toBe("plugin:example-editor");
  });

  it("selects an enabled editor contribution without depending on its plugin id", () => {
    expect(
      resolveEditorTarget({
        id: "plugin:example-editor",
        plugins: [editor],
        desktop: true,
        mobile: false,
      }),
    ).toMatchObject({ kind: "plugin", id: "plugin:example-editor", plugin: editor });
  });

  it.each([
    ["missing", []],
    ["disabled", [{ ...editor, enablement: { ...editor.enablement, effective: false } }]],
    ["blocked", [{ ...editor, status: "blocked" as const }]],
    ["without contribution", [{ ...editor, editor: null }]],
    ["not built", [{ ...editor, entry_present: false }]],
  ])("explains the CodeMirror fallback for a %s plugin", (_, plugins) => {
    const target = resolveEditorTarget({
      id: "plugin:example-editor",
      plugins,
      desktop: true,
      mobile: false,
    });
    expect(target.kind).toBe("codemirror");
    if (target.kind !== "codemirror") throw new Error("Expected a CodeMirror fallback");
    expect(target.reason).toEqual(expect.any(String));
    expect(target.reason?.length).toBeGreaterThan(0);
  });

  it.each(["neovim", "plugin:example-editor"])("falls back on remote and mobile for %s", (id) => {
    for (const environment of [
      { desktop: false, mobile: false },
      { desktop: true, mobile: true },
    ]) {
      expect(resolveEditorTarget({ id, plugins: [editor], ...environment })).toMatchObject({
        kind: "codemirror",
        reason: expect.any(String),
      });
    }
  });

  it("does not run an editor while its setting or plugin catalog is loading", () => {
    expect(
      resolveEditorTarget({
        id: "plugin:example-editor",
        plugins: [],
        desktop: true,
        mobile: false,
        loading: true,
      }).kind,
    ).toBe("loading");
  });

  it("explains an unknown backend instead of silently interpreting it as Neovim", () => {
    expect(
      resolveEditorTarget({ id: "unknown", plugins: [], desktop: true, mobile: false }),
    ).toMatchObject({ kind: "codemirror", reason: expect.any(String) });
  });
});
