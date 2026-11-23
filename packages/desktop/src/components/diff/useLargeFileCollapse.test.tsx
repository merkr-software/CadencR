import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LARGE_DIFF_LINES } from "@/lib/diff-thresholds";
import { useFileCollapseState, type CollapsibleFile } from "./useLargeFileCollapse";

const smallFile: CollapsibleFile = { file: "src/small.ts", additions: 10, deletions: 2 };
const hugeFile: CollapsibleFile = {
  file: "src/generated.ts",
  additions: LARGE_DIFF_LINES + 500,
  deletions: 0,
};

describe("useFileCollapseState", () => {
  it("collapses large files synchronously on the initial render before any effect runs", () => {
    const firstRenderSnapshots: boolean[] = [];
    renderHook(() => {
      const state = useFileCollapseState([smallFile, hugeFile]);
      firstRenderSnapshots.push(state.collapsedFiles.has(hugeFile.file));
      return state;
    });

    // Even on render 0 (before any useEffect can fire), hugeFile is collapsed.
    expect(firstRenderSnapshots[0]).toBe(true);
  });

  it("keeps small files expanded and supports toggling/expanding/collapsing both", () => {
    const { result } = renderHook(({ files }) => useFileCollapseState(files), {
      initialProps: { files: [smallFile, hugeFile] },
    });

    expect(result.current.collapsedFiles.has(smallFile.file)).toBe(false);
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(true);

    // Expanding a large file works and sticks within the same diff.
    act(() => result.current.toggleFile(hugeFile.file));
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(false);

    // Collapsing it again works.
    act(() => result.current.collapseFile(hugeFile.file));
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(true);

    // expandFile (used by revealFile / navigation) expands a large file.
    act(() => result.current.expandFile(hugeFile.file));
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(false);

    // Normal file toggles cleanly.
    act(() => result.current.toggleFile(smallFile.file));
    expect(result.current.collapsedFiles.has(smallFile.file)).toBe(true);
    act(() => result.current.toggleFile(smallFile.file));
    expect(result.current.collapsedFiles.has(smallFile.file)).toBe(false);
  });

  it("re-collapses large files synchronously when a different diff loads", () => {
    const { result, rerender } = renderHook(({ files }) => useFileCollapseState(files), {
      initialProps: { files: [smallFile, hugeFile] },
    });

    act(() => result.current.expandFile(hugeFile.file));
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(false);

    // Switching to another diff (different file set) re-collapses large files immediately.
    const nextHuge: CollapsibleFile = {
      file: "src/other.ts",
      additions: LARGE_DIFF_LINES,
      deletions: 0,
    };
    rerender({ files: [hugeFile, nextHuge] });
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(true);
    expect(result.current.collapsedFiles.has(nextHuge.file)).toBe(true);
  });

  it("does not leave a re-collapsed large file stuck collapsed if it later shrinks below threshold", () => {
    const { result, rerender } = renderHook(({ files }) => useFileCollapseState(files), {
      initialProps: { files: [smallFile, hugeFile] },
    });

    // Expand then re-collapse the large file.
    act(() => result.current.expandFile(hugeFile.file));
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(false);
    act(() => result.current.collapseFile(hugeFile.file));
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(true);

    // File later shrinks below LARGE_DIFF_LINES: it should now be expanded by default.
    const shrunkFile: CollapsibleFile = { file: hugeFile.file, additions: 20, deletions: 5 };
    rerender({ files: [smallFile, shrunkFile] });
    expect(result.current.collapsedFiles.has(hugeFile.file)).toBe(false);
  });

  it("preserves collapsedFiles referential stability across refetches when no files are large", () => {
    const { result, rerender } = renderHook(({ files }) => useFileCollapseState(files), {
      initialProps: { files: [smallFile] },
    });
    const initialSet = result.current.collapsedFiles;

    rerender({ files: [{ ...smallFile }, { file: "src/another.ts", additions: 3, deletions: 1 }] });
    expect(result.current.collapsedFiles).toBe(initialSet);
  });
});
