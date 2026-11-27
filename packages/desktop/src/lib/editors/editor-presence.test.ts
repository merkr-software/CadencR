import { describe, expect, it, vi } from "vitest";
import {
  pluginTabSummary,
  linuxOnlyBackendTab,
} from "@/components/plugin-tabs/plugin-tab-fixtures";
import { EditorPresenceRegistry, wantedEditorLeases } from "./editor-presence";

const editor = linuxOnlyBackendTab({
  id: "example",
  backend_availability: "available",
  editor: { label: "Editor", open_method: "files.open" },
});
describe("editor presence", () => {
  it("leases only conversations that used the selected, available editor", () => {
    const wanted = wantedEditorLeases(
      "plugin:example",
      { 7: "plugin:example", 8: "plugin:other" },
      { 7: 1, 8: 1, 9: 1 },
      () => [editor],
    );
    expect(wanted).toEqual([
      { instanceId: "7:editor:example", pluginId: "example", featureId: 7, name: editor.name },
    ]);
    expect(
      wantedEditorLeases("codemirror", { 7: "plugin:example" }, { 7: 1 }, () => [editor]),
    ).toEqual([]);
  });
  it.each(
    [
      [],
      [pluginTabSummary({ id: "example" })],
      [{ ...editor, enablement: { ...editor.enablement, effective: false } }],
      [{ ...editor, status: "blocked" as const }],
    ].map((plugins) => ({ plugins })),
  )("releases unavailable contributions", ({ plugins }) => {
    expect(
      wantedEditorLeases("plugin:example", { 7: "plugin:example" }, { 7: 1 }, () => plugins),
    ).toEqual([]);
  });
  it("drops deleted conversations even when their editor history remains", () => {
    expect(
      wantedEditorLeases("plugin:example", { 7: "plugin:example" }, {}, () => [editor]),
    ).toEqual([]);
  });
  it("keeps ownership through unrelated renders, and releases once on disablement", () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const registry = new EditorPresenceRegistry(acquire);
    const wanted = wantedEditorLeases("plugin:example", { 7: "plugin:example" }, { 7: 1 }, () => [
      editor,
    ]);
    registry.sync(wanted);
    registry.sync(wanted);
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    registry.sync([]);
    registry.dispose();
    expect(release).toHaveBeenCalledOnce();
  });
});
