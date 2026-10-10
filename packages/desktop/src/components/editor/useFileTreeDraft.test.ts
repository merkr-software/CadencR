// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import type { FileTree, FileTreeRenameEvent } from "@pierre/trees";
import { describe, expect, it, vi } from "vitest";
import { useFileTreeDraft } from "./useFileTreeDraft";
import type { FileTreeMutations } from "@/hooks/useFileTreeMutations";

function createModelStub(): FileTree {
  const paths = new Set<string>();
  return {
    add: (path: string) => {
      paths.add(path);
    },
    getItem: (path: string) => (paths.has(path) ? ({} as unknown) : null),
    onMutation: () => () => undefined,
    remove: (path: string) => {
      paths.delete(path);
    },
    startRenaming: () => true,
  } as unknown as FileTree;
}

function createInspectableModelStub(): {
  addPath: (path: string) => void;
  addPathMock: ReturnType<typeof vi.fn>;
  hasPath: (path: string) => boolean;
  model: FileTree;
  removePath: ReturnType<typeof vi.fn>;
} {
  const paths = new Set<string>();
  const addPathMock = vi.fn((path: string): void => {
    paths.add(path);
  });
  const removePath = vi.fn((path: string): void => {
    paths.delete(path);
  });
  const model = {
    add: addPathMock,
    getItem: (path: string) => (paths.has(path) ? ({} as unknown) : null),
    onMutation: () => () => undefined,
    remove: removePath,
    startRenaming: () => true,
  } as unknown as FileTree;
  return {
    addPath: addPathMock,
    addPathMock,
    hasPath: (path: string) => paths.has(path),
    model,
    removePath,
  };
}

function createMutationsStub(): {
  createFolderMutate: ReturnType<typeof vi.fn>;
  mutations: FileTreeMutations;
} {
  const createFileMutate = vi.fn();
  const createFolderMutate = vi.fn();
  const mutations = {
    createFile: { mutate: createFileMutate },
    createFolder: { mutate: createFolderMutate },
  } as unknown as FileTreeMutations;
  return { createFolderMutate, mutations };
}

describe("useFileTreeDraft", () => {
  it("handles folder draft rename events whose source path omits Pierre's directory slash", () => {
    const model = createModelStub();
    const { createFolderMutate, mutations } = createMutationsStub();
    const { result } = renderHook(() =>
      useFileTreeDraft({
        model,
        projectId: 1,
        featureId: 2,
        mutations,
        onFileCreated: vi.fn(),
        featureKey: 2,
      }),
    );

    act(() => result.current.startCreate("folder", "packages/desktop"));

    const event: FileTreeRenameEvent = {
      sourcePath: "packages/desktop/ ",
      destinationPath: "packages/desktop/new-folder",
      isFolder: true,
    };

    expect(result.current.tryHandleAsCreate(event)).toBe(true);
    expect(createFolderMutate).toHaveBeenCalledWith(
      {
        data: {
          project_id: 1,
          feature_id: 2,
          dir_path: "packages/desktop/new-folder",
        },
      },
      { onError: expect.any(Function), onSuccess: expect.any(Function) },
    );
  });

  it("removes the committed folder draft from the local model while backend create is pending", async () => {
    const { addPath, hasPath, model, removePath } = createInspectableModelStub();
    const { mutations } = createMutationsStub();
    const { result } = renderHook(() =>
      useFileTreeDraft({
        model,
        projectId: 1,
        featureId: 2,
        mutations,
        onFileCreated: vi.fn(),
        featureKey: 2,
      }),
    );

    act(() => result.current.startCreate("folder", "packages/desktop"));

    const event: FileTreeRenameEvent = {
      sourcePath: "packages/desktop/ ",
      destinationPath: "packages/desktop/2",
      isFolder: true,
    };

    expect(result.current.tryHandleAsCreate(event)).toBe(true);
    act(() => addPath("packages/desktop/2/"));
    expect(hasPath("packages/desktop/2/")).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(removePath).toHaveBeenCalledWith("packages/desktop/2/", { recursive: true });
    expect(hasPath("packages/desktop/2/")).toBe(false);
  });

  it("removes an invalid folder draft even when Pierre's destination path omits the directory slash", () => {
    const { addPath, hasPath, model, removePath } = createInspectableModelStub();
    const { mutations } = createMutationsStub();
    const { result } = renderHook(() =>
      useFileTreeDraft({
        model,
        projectId: 1,
        featureId: 2,
        mutations,
        onFileCreated: vi.fn(),
        featureKey: 2,
      }),
    );

    act(() => result.current.startCreate("folder", "packages/desktop"));
    act(() => addPath("packages/desktop/../"));

    expect(
      result.current.tryHandleAsCreate({
        sourcePath: "packages/desktop/ ",
        destinationPath: "packages/desktop/..",
        isFolder: true,
      }),
    ).toBe(true);

    expect(removePath).toHaveBeenCalledWith("packages/desktop/../", { recursive: true });
    expect(hasPath("packages/desktop/../")).toBe(false);
  });

  it("adds a backend-confirmed folder to the local model without waiting for refetch", async () => {
    const { addPathMock, model } = createInspectableModelStub();
    const { createFolderMutate, mutations } = createMutationsStub();
    const { result } = renderHook(() =>
      useFileTreeDraft({
        model,
        projectId: 1,
        featureId: 2,
        mutations,
        onFileCreated: vi.fn(),
        featureKey: 2,
      }),
    );

    act(() => result.current.startCreate("folder", "packages/desktop"));
    expect(
      result.current.tryHandleAsCreate({
        sourcePath: "packages/desktop/ ",
        destinationPath: "packages/desktop/2",
        isFolder: true,
      }),
    ).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });

    const options = createFolderMutate.mock.calls[0]?.[1] as
      | { onSuccess?: (response: { path: string }) => void }
      | undefined;
    act(() => options?.onSuccess?.({ path: "packages/desktop/2" }));

    expect(addPathMock).toHaveBeenCalledWith("packages/desktop/2/");
  });
});
