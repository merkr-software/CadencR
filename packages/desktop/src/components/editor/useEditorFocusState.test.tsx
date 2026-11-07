import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { pluginTabSummary } from "@/components/plugin-tabs/plugin-tab-fixtures";
import type { EditorTarget } from "@/lib/editors/editor-registry";

const navigation = vi.hoisted(() => ({
  focus: vi.fn().mockResolvedValue(undefined),
  isOpening: vi.fn(() => false),
}));
vi.mock("@/lib/editors/editor-runtime", () => ({ editorNavigation: navigation }));
import { useEditorFocusState } from "./useEditorFocusState";

it("cancels pending plugin focus when CodeMirror takes over under the same editor id", () => {
  const target: EditorTarget = {
    kind: "plugin",
    id: "plugin:example",
    plugin: pluginTabSummary({ id: "example" }),
  };
  const initialProps: { selected: EditorTarget } = { selected: target };
  const { result, rerender, unmount } = renderHook(
    ({ selected }: { selected: EditorTarget }) => useEditorFocusState(7, "main", true, selected),
    { initialProps },
  );
  act(() => result.current.focusActiveEditor());
  const current = navigation.focus.mock.calls[0]?.[2] as () => boolean;
  expect(current()).toBe(true);
  rerender({
    selected: { kind: "codemirror", id: target.id, reason: "The plugin did not answer." },
  });
  expect(current()).toBe(false);
  unmount();
  expect(current()).toBe(false);
});
