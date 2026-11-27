import { uiI18n } from "@/lib/i18n/ui";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEditorSave } from "./useEditorSave";

const { mutate, read, setDirty, toastError } = vi.hoisted(() => ({
  mutate: vi.fn(),
  read: vi.fn(),
  setDirty: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/api/generated", () => ({
  useWriteFile: () => ({ mutateAsync: mutate }),
  readFile: read,
  getReadFileQueryKey: (params: unknown) => ["/api/editor/read", params],
}));
vi.mock("@/stores/editor-store", () => ({
  useEditorStore: (select: (state: { setDirty: typeof setDirty }) => unknown) =>
    select({ setDirty }),
}));
vi.mock("@/lib/api-errors", () => ({
  toastError,
  apiErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
const views: EditorView[] = [];
beforeEach(() => {
  mutate.mockReset().mockResolvedValue(undefined);
  read.mockReset();
  setDirty.mockClear();
  toastError.mockClear();
});
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(beforeWrite = vi.fn(async () => {})) {
  const view = new EditorView({ state: EditorState.create({ doc: "original" }) });
  views.push(view);
  const viewRef = { current: view };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ content }) =>
      useEditorSave({
        projectId: 1,
        featureId: 2,
        paneId: "pane",
        filePath: "test.ts",
        content,
        viewRef,
        beforeWrite,
      }),
    { wrapper, initialProps: { content: "original" } },
  );
  const edit = (insert: string) =>
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } });
      hook.result.current.onDocChange(view.state.doc);
    });
  return { ...hook, view, viewRef, client, edit, beforeWrite };
}

describe("save and reload ordering", () => {
  it("keeps typing after a slow save dirty and never replaces the live document", async () => {
    const h = setup();
    h.edit("save snapshot");
    const pending = deferred<void>();
    mutate.mockReturnValue(pending.promise);
    let saving!: Promise<void>;
    await act(async () => {
      saving = h.result.current.save();
    });
    expect(h.result.current.isSaving).toBe(true);
    h.edit("typing during save");
    await act(async () => {
      pending.resolve();
      await saving;
    });
    expect(mutate).toHaveBeenCalledWith({
      data: expect.objectContaining({ content: "save snapshot" }),
    });
    expect(h.view.state.doc.toString()).toBe("typing during save");
    expect(setDirty).not.toHaveBeenCalledWith(2, "pane", "test.ts", false);
  });

  it("serializes overlapping saves and captures the newest buffer for queued writes", async () => {
    const h = setup();
    const pending = deferred<void>();
    mutate.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    h.edit("first");
    let a!: Promise<void>, b!: Promise<void>;
    await act(async () => {
      a = h.result.current.save();
    });
    h.edit("second");
    await act(async () => {
      b = h.result.current.save();
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
      await Promise.all([a, b]);
    });
    expect(mutate.mock.calls.map((call) => call[0].data.content)).toEqual(["first", "second"]);
    expect(setDirty).toHaveBeenLastCalledWith(2, "pane", "test.ts", false);
  });

  it("autosaves without invoking format-on-save", async () => {
    const h = setup();
    h.edit("user requested spacing");
    await act(async () => {
      await h.result.current.saveQuiet();
    });
    expect(h.beforeWrite).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith({
      data: expect.objectContaining({ content: "user requested spacing" }),
    });
    expect(h.result.current.autoSavedVisible).toBe(true);
  });

  it("pauses autosave and rejects ordinary saves on conflict, but permits explicit overwrite", async () => {
    const h = setup();
    h.edit("mine");
    h.rerender({ content: "outside" });
    await act(async () => {
      await h.result.current.saveQuiet();
      await h.result.current.save();
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(h.result.current.errorMessage).toContain("File changed on disk");
    await act(async () => {
      await h.result.current.overwriteDisk();
    });
    expect(mutate).toHaveBeenCalledWith({ data: expect.objectContaining({ content: "mine" }) });
    expect(h.result.current.diskChanged).toBe(false);
  });

  it("reloads fresh disk content explicitly and does not autosave the reloaded document", async () => {
    const h = setup();
    h.edit("mine");
    h.rerender({ content: "outside" });
    read.mockResolvedValue({ content: "latest on disk", line_count: 1, large: false });
    await act(async () => {
      await h.result.current.reloadFromDisk();
      await h.result.current.saveQuiet();
    });
    expect(h.view.state.doc.toString()).toBe("latest on disk");
    expect(h.result.current.diskChanged).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("preserves edits made while a reload is in flight", async () => {
    const h = setup();
    h.edit("mine");
    h.rerender({ content: "outside" });
    const pending = deferred<{ content: string }>();
    read.mockReturnValue(pending.promise);
    let reloading!: Promise<void>;
    await act(async () => {
      reloading = h.result.current.reloadFromDisk();
    });
    h.edit("new typing");
    await act(async () => {
      pending.resolve({ content: "disk" });
      await reloading;
    });
    expect(h.view.state.doc.toString()).toBe("new typing");
    expect(h.result.current.errorMessage).toContain("buffer changed while reloading");
  });

  it("keeps edits and conflict after failed reload, and can retry", async () => {
    const h = setup();
    h.edit("mine");
    h.rerender({ content: "outside" });
    read.mockRejectedValueOnce(new Error("Disk unavailable"));
    await act(async () => {
      await h.result.current.reloadFromDisk();
    });
    expect(h.view.state.doc.toString()).toBe("mine");
    expect(h.result.current.diskChanged).toBe(true);
    expect(h.result.current.errorMessage).toBe("Disk unavailable");
    read.mockResolvedValue({ content: "recovered disk" });
    await act(async () => {
      await h.result.current.reloadFromDisk();
    });
    expect(h.view.state.doc.toString()).toBe("recovered disk");
  });

  it("does not poison the save queue after a write failure", async () => {
    const h = setup();
    h.edit("mine");
    mutate.mockRejectedValueOnce(new Error("Write failed"));
    await act(async () => {
      await h.result.current.save();
    });
    expect(h.result.current.errorMessage).toBe("Write failed");
    expect(setDirty).not.toHaveBeenCalledWith(2, "pane", "test.ts", false);
    await act(async () => {
      await h.result.current.save();
    });
    expect(h.result.current.errorMessage).toBe(null);
    expect(setDirty).toHaveBeenLastCalledWith(2, "pane", "test.ts", false);
  });

  it("rejects a close-guard save on conflict instead of allowing unsaved edits to be discarded", async () => {
    const h = setup();
    h.edit("mine");
    h.rerender({ content: "outside" });
    await act(async () => {
      await expect(h.result.current.saveForClose()).rejects.toThrow("File changed on disk");
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(h.view.state.doc.toString()).toBe("mine");
  });

  it("rejects a close-guard save if newer typing remains unsaved", async () => {
    const h = setup();
    h.edit("snapshot");
    const pending = deferred<void>();
    mutate.mockReturnValue(pending.promise);
    let saved!: Promise<void>;
    await act(async () => {
      saved = h.result.current.saveForClose();
    });
    h.edit("new typing");
    await act(async () => {
      pending.resolve();
      await expect(saved).rejects.toThrow("still has unsaved changes");
    });
    expect(h.view.state.doc.toString()).toBe("new typing");
  });

  it("cancels stale file reads before reconciling a completed write", async () => {
    const h = setup();
    const pending = deferred<string>();
    const key = ["/api/editor/read", { project_id: 1, feature_id: 2, file_path: "test.ts" }];
    const staleRead = h.client
      .fetchQuery({ queryKey: key, queryFn: () => pending.promise })
      .catch(() => "cancelled");
    h.edit("new saved value");
    await act(async () => {
      await h.result.current.save();
      pending.resolve("stale disk");
      await staleRead;
    });
    expect(h.client.getQueryData(key)).toEqual(
      expect.objectContaining({ content: "new saved value" }),
    );
  });
  it("reports a conflict arriving while manual-save formatting is pending", async () => {
    const formatting = deferred<void>();
    const h = setup(vi.fn(() => formatting.promise));
    h.edit("mine");
    let saving!: Promise<void>;
    await act(async () => {
      saving = h.result.current.save();
    });
    h.rerender({ content: "external while formatting" });
    await act(async () => {
      formatting.resolve();
      await saving;
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(h.result.current.errorMessage).toContain("File changed on disk");
    expect(toastError).toHaveBeenCalled();
  });

  it.each([
    ["", 0],
    ["one", 1],
    ["one\n", 1],
    ["one\ntwo", 2],
    ["one\n\n", 2],
  ])("uses document metadata for the saved line count of %j", async (content, lineCount) => {
    const h = setup();
    h.edit(content);
    await act(async () => {
      await h.result.current.save();
    });
    const key = ["/api/editor/read", { project_id: 1, feature_id: 2, file_path: "test.ts" }];
    expect(h.client.getQueryData(key)).toEqual({ content, line_count: lineCount, large: false });
  });
});

describe("editor save error localization", () => {
  afterEach(async () => {
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
    uiI18n.removeResourceBundle("fr", "ui");
  });

  it.each(["upstream", "fallback", "conflict"] as const)(
    "updates persistent %s errors without re-emitting the toast",
    async (source) => {
      const h = setup();
      h.edit("keep these edits");
      if (source === "conflict") h.rerender({ content: "outside" });
      else mutate.mockRejectedValue(source === "upstream" ? new Error("Disk unavailable") : null);
      await act(async () => {
        await h.result.current.save();
      });
      const english = h.result.current.errorMessage;
      expect(english).toEqual(source === "upstream" ? "Disk unavailable" : expect.any(String));
      expect(toastError).toHaveBeenCalledTimes(1);

      uiI18n.addResourceBundle("fr", "ui", {
        workspace: {
          editor: {
            save: { syncFailed: "Échec de la synchronisation" },
            useEditorWrite: { diskChanged: "Le fichier a changé sur le disque" },
          },
        },
      });
      await act(async () => {
        await uiI18n.changeLanguage("fr");
      });
      expect(h.result.current.errorMessage).toBe(
        {
          upstream: "Disk unavailable",
          fallback: "Échec de la synchronisation",
          conflict: "Le fichier a changé sur le disque",
        }[source],
      );
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(h.view.state.doc.toString()).toBe("keep these edits");
    },
  );
});
