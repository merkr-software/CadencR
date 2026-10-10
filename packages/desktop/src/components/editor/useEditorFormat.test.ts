// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEditorFormat } from "./useEditorFormat";

const { format } = vi.hoisted(() => ({ format: vi.fn() }));
vi.mock("@/api/generated", () => ({ format }));
vi.mock("@/hooks/useShortcut", () => ({ useScopedGlobalShortcutById: vi.fn() }));
vi.mock("@/lib/lsp/useProjectEditorTooling", () => ({
  useProjectEditorTooling: () => ({ formatter: "oxfmt", formatOnSave: true }),
}));
const views: EditorView[] = [];
beforeEach(() => format.mockReset());
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function setup(content = "const x=1") {
  const view = new EditorView({ state: EditorState.create({ doc: content }) });
  views.push(view);
  const viewRef = { current: view };
  const hook = renderHook(() =>
    useEditorFormat({ projectId: 1, featureId: 2, filePath: "test.ts", viewRef, largeMode: false }),
  );
  return { ...hook, viewRef, view };
}

function deferred() {
  let resolve!: (value: { content: string }) => void;
  const promise = new Promise<{ content: string }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("formatter snapshot ownership", () => {
  it("discards a slow formatter response after newer typing, including in a large buffer", async () => {
    const initial = "const x=1;\n".repeat(100_000);
    const h = setup(initial);
    const pending = deferred();
    format.mockReturnValue(pending.promise);
    let result!: Promise<boolean>;
    act(() => {
      result = h.result.current.formatDocument();
    });
    expect(h.result.current.isFormatting).toBe(true);
    h.view.dispatch({ changes: { from: 0, insert: "// my new input\n" } });
    const current = h.view.state.doc;
    await act(async () => {
      pending.resolve({ content: "const x = 1;\n".repeat(100_000) });
      await result;
    });
    expect(await result).toBe(false);
    expect(h.view.state.doc).toBe(current);
    expect(h.view.state.doc.toString()).toBe("// my new input\n" + initial);
    expect(h.result.current.isFormatting).toBe(false);
  });

  it("applies formatting when the same view and document still own the response", async () => {
    const h = setup();
    format.mockResolvedValue({ content: "const x = 1;" });
    await act(async () => {
      expect(await h.result.current.formatDocument()).toBe(true);
    });
    expect(h.view.state.doc.toString()).toBe("const x = 1;");
  });

  it("never applies a response to a replacement view", async () => {
    const h = setup();
    const pending = deferred();
    format.mockReturnValue(pending.promise);
    let result!: Promise<boolean>;
    act(() => {
      result = h.result.current.formatDocument();
    });
    const replacement = new EditorView({ state: EditorState.create({ doc: "other file" }) });
    views.push(replacement);
    h.viewRef.current = replacement;
    await act(async () => {
      pending.resolve({ content: "old formatted file" });
      await result;
    });
    expect(replacement.state.doc.toString()).toBe("other file");
    expect(h.view.state.doc.toString()).toBe("const x=1");
  });

  it("ignores out-of-order concurrent format requests", async () => {
    const h = setup();
    const first = deferred();
    const second = deferred();
    format.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let a!: Promise<boolean>, b!: Promise<boolean>;
    act(() => {
      a = h.result.current.formatDocument();
      b = h.result.current.formatDocument();
    });
    await act(async () => {
      second.resolve({ content: "new format" });
      await b;
    });
    expect(h.result.current.isFormatting).toBe(true);
    await act(async () => {
      first.resolve({ content: "old format" });
      await a;
    });
    expect(h.view.state.doc.toString()).toBe("new format");
    expect(h.result.current.isFormatting).toBe(false);
  });
});
