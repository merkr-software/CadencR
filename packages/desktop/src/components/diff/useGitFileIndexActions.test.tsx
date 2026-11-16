import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stageMutate: vi.fn(),
  resetMutate: vi.fn(),
  stageOptions: undefined as
    | {
        onError?: (error: unknown, variables: { data: { file_path: string } }) => void;
        onSuccess?: (response: unknown, variables: { data: { file_path: string } }) => void;
        onSettled?: () => void;
      }
    | undefined,
  resetOptions: undefined as
    | {
        onError?: (error: unknown, variables: { data: { file_path: string } }) => void;
        onSuccess?: (response: unknown, variables: { data: { file_path: string } }) => void;
        onSettled?: () => void;
      }
    | undefined,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  gitPrefix: "" as string | null | undefined,
}));

vi.mock("@/hooks/useGitPathPrefix", () => ({ useGitPathPrefix: () => mocks.gitPrefix }));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

vi.mock("@/api/generated", () => ({
  FileStageState: {
    not_applicable: "not_applicable",
    untracked: "untracked",
    unstaged: "unstaged",
    staged: "staged",
    both: "both",
    conflicted: "conflicted",
  },
  useStageFile: ({ mutation }: { mutation: typeof mocks.stageOptions }) => {
    mocks.stageOptions = mutation;
    return { mutate: mocks.stageMutate };
  },
  useResetFile: ({ mutation }: { mutation: typeof mocks.resetOptions }) => {
    mocks.resetOptions = mutation;
    return { mutate: mocks.resetMutate };
  },
}));

import { FileStageState } from "@/api/generated";
import { useEditorStore } from "@/stores/editor-store";
import { getGitFileActionAvailability, useGitFileIndexActions } from "./useGitFileIndexActions";

beforeEach(() => {
  mocks.stageMutate.mockReset();
  mocks.resetMutate.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.toastWarning.mockReset();
  useEditorStore.setState({ features: {} });
  mocks.gitPrefix = "";
});

describe("useGitFileIndexActions", () => {
  it.each([
    [FileStageState.not_applicable, false, false],
    [FileStageState.untracked, true, false],
    [FileStageState.unstaged, true, false],
    [FileStageState.staged, false, true],
    [FileStageState.both, true, true],
    [FileStageState.conflicted, true, false],
  ] as const)("reports stage/reset availability for %s", (stageState, canStage, canReset) => {
    expect(getGitFileActionAvailability(stageState)).toEqual({ canStage, canReset });
  });

  it("sends exact file paths for separate completed stage/reset operations", () => {
    const { result } = renderHook(() => useGitFileIndexActions(42));

    act(() => result.current.stage("src/file with spaces.ts"));
    act(() => mocks.stageOptions?.onSettled?.());
    act(() => result.current.reset("src/file with spaces.ts"));

    expect(mocks.stageMutate).toHaveBeenCalledWith({
      data: { feature_id: 42, file_path: "src/file with spaces.ts" },
    });
    expect(mocks.resetMutate).toHaveBeenCalledWith({
      data: { feature_id: 42, file_path: "src/file with spaces.ts" },
    });
  });

  it("atomically suppresses a same-tick second mutation until settlement", () => {
    const { result } = renderHook(() => useGitFileIndexActions(42));

    act(() => {
      result.current.stage("src/busy.ts");
      result.current.reset("src/other.ts");
    });
    expect(result.current).toMatchObject({
      isPending: true,
      pendingAction: "stage",
      pendingPath: "src/busy.ts",
    });
    expect(mocks.stageMutate).toHaveBeenCalledOnce();
    expect(mocks.resetMutate).not.toHaveBeenCalled();

    act(() => mocks.stageOptions?.onSettled?.());
    expect(result.current.isPending).toBe(false);
    act(() => result.current.reset("src/other.ts"));
    expect(mocks.resetMutate).toHaveBeenCalledWith({
      data: { feature_id: 42, file_path: "src/other.ts" },
    });
  });

  it("refuses to stage stale worktree bytes while the exact Editor buffer is dirty", () => {
    const editor = useEditorStore.getState();
    editor.initFeature(42);
    editor.openFile(42, "main", "src/conflict.ts");
    editor.setDirty(42, "main", "src/conflict.ts", true);
    const { result } = renderHook(() => useGitFileIndexActions(42));

    act(() => result.current.stage("src/conflict.ts"));

    expect(mocks.stageMutate).not.toHaveBeenCalled();
    expect(result.current.error).toEqual({
      action: "stage",
      filePath: "src/conflict.ts",
      message: "Save the open Editor buffer before staging this file.",
    });
    expect(mocks.toastError).toHaveBeenCalledWith("Could not stage src/conflict.ts", {
      description: "Save the open Editor buffer before staging this file.",
    });
  });

  it("matches a monorepo Git path to its dirty Editor buffer", () => {
    mocks.gitPrefix = "packages/app";
    const editor = useEditorStore.getState();
    editor.initFeature(42);
    editor.openFile(42, "main", "src/conflict.ts");
    editor.setDirty(42, "main", "src/conflict.ts", true);
    const { result } = renderHook(() => useGitFileIndexActions(42));

    act(() => result.current.stage("packages/app/src/conflict.ts"));
    expect(mocks.stageMutate).not.toHaveBeenCalled();
    expect(result.current.error?.message).toBe(
      "Save the open Editor buffer before staging this file.",
    );

    // The repository root's own `src/conflict.ts` is another file.
    act(() => result.current.stage("src/conflict.ts"));
    expect(mocks.stageMutate).toHaveBeenCalledWith({
      data: { feature_id: 42, file_path: "src/conflict.ts" },
    });
  });

  it("does not stage before the Git prefix is known", () => {
    mocks.gitPrefix = undefined;
    const { result } = renderHook(() => useGitFileIndexActions(42));

    act(() => result.current.stage("src/a.ts"));

    expect(mocks.stageMutate).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("Could not stage src/a.ts", {
      description: "The project's Git root is still loading; try again.",
    });
  });

  it("retains the actionable API error for inline UI and a toast", () => {
    const { result } = renderHook(() => useGitFileIndexActions(42));

    act(() => {
      mocks.stageOptions?.onError?.(new Error("index is locked"), {
        data: { file_path: "src/conflict.ts" },
      });
    });

    expect(result.current.error).toEqual({
      action: "stage",
      filePath: "src/conflict.ts",
      message: "index is locked",
    });
    expect(mocks.toastError).toHaveBeenCalledWith("Could not stage src/conflict.ts", {
      description: "index is locked",
    });
  });

  it("does not toast success after a normal stage", () => {
    const { result } = renderHook(() => useGitFileIndexActions(42));

    act(() => result.current.stage("src/clean.ts"));
    act(() => {
      mocks.stageOptions?.onSuccess?.({}, { data: { file_path: "src/clean.ts" } });
    });

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });

  it("toasts a warning when staging with conflicted: true", () => {
    const { result } = renderHook(() => useGitFileIndexActions(42));

    act(() => result.current.stage("src/conflict.ts", { conflicted: true }));
    act(() => {
      mocks.stageOptions?.onSuccess?.({}, { data: { file_path: "src/conflict.ts" } });
    });

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastWarning).toHaveBeenCalledWith("Staged src/conflict.ts with conflicts", {
      description: "Confirm conflict markers are resolved before continuing the merge.",
    });
  });

  it("does not toast success after reset", () => {
    renderHook(() => useGitFileIndexActions(42));

    act(() => {
      mocks.resetOptions?.onSuccess?.({}, { data: { file_path: "src/file.ts" } });
    });

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
