// @vitest-environment happy-dom
import { FileTree, preloadFileTree, type FileTreeDirectoryHandle } from "@pierre/trees";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useFileTreeIconSet", () => ({
  useFileTreeIconSet: () => ({ iconSet: "standard", setIconSet: vi.fn(), isLoading: false }),
}));

import { resetFileTreePathsPreservingState, useCadencrFileTree } from "./CadencrFileTree";

describe("CadencrFileTree model contract", () => {
  it("preserves Pierre selection, focus, expansion, and search across path resets", () => {
    const model = new FileTree({
      paths: ["src/", "src/a.ts", "src/nested/", "src/nested/b.ts", "other/", "other/c.ts"],
      initialExpansion: "closed",
      initialSelectedPaths: ["src/a.ts"],
      search: true,
    });
    const src = model.getItem("src/");
    expect(src?.isDirectory()).toBe(true);
    if (src?.isDirectory()) (src as FileTreeDirectoryHandle).expand();
    model.focusPath("src/a.ts");
    model.setSearch("a.ts");

    resetFileTreePathsPreservingState(model, [
      "src/",
      "src/a.ts",
      "src/new.ts",
      "src/nested/",
      "src/nested/b.ts",
      "other/",
      "other/c.ts",
    ]);

    expect(model.getSelectedPaths()).toEqual(["src/a.ts"]);
    expect(model.getFocusedPath()).toBe("src/a.ts");
    expect(model.getSearchValue()).toBe("a.ts");
    const resetSrc = model.getItem("src/");
    const resetOther = model.getItem("other/");
    expect(resetSrc?.isDirectory() && (resetSrc as FileTreeDirectoryHandle).isExpanded()).toBe(
      true,
    );
    expect(resetOther?.isDirectory() && (resetOther as FileTreeDirectoryHandle).isExpanded()).toBe(
      false,
    );
    model.cleanUp();
  });

  it("keeps the large-list virtualization contract", () => {
    const paths = Array.from({ length: 2_000 }, (_, index) => `src/file-${index}.ts`);
    const payload = preloadFileTree({ paths, initialVisibleRowCount: 12 });
    const renderedRows = payload.shadowHtml.match(/data-item-path=/g)?.length ?? 0;

    expect(payload.shadowHtml).toContain('data-file-tree-virtualized-root="true"');
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(paths.length);
  });

  it("opens directories on first async population, then preserves a deliberate collapse", () => {
    const { result, rerender, unmount } = renderHook(
      ({ paths }: { paths: readonly string[] }) =>
        useCadencrFileTree({ paths, initialExpansion: "open", iconSet: "standard" }),
      { initialProps: { paths: [] as readonly string[] } },
    );

    rerender({ paths: ["src/", "src/nested/", "src/nested/a.ts"] });
    const src = result.current.model.getItem("src/");
    const nested = result.current.model.getItem("src/nested/");
    expect(src?.isDirectory() && (src as FileTreeDirectoryHandle).isExpanded()).toBe(true);
    expect(nested?.isDirectory() && (nested as FileTreeDirectoryHandle).isExpanded()).toBe(true);

    act(() => {
      if (src?.isDirectory()) (src as FileTreeDirectoryHandle).collapse();
    });
    rerender({
      paths: ["src/", "src/nested/", "src/nested/a.ts", "src/nested/b.ts"],
    });
    const resetSrc = result.current.model.getItem("src/");
    expect(resetSrc?.isDirectory() && (resetSrc as FileTreeDirectoryHandle).isExpanded()).toBe(
      false,
    );
    unmount();
  });

  it("skips equivalent path resets while honoring an explicit reset version", () => {
    const initialPaths = ["src/", "src/a.ts"] as const;
    const { result, rerender, unmount } = renderHook(
      ({ paths, pathResetVersion }: { paths: readonly string[]; pathResetVersion: string }) =>
        useCadencrFileTree({
          paths,
          pathResetVersion,
          iconSet: "standard",
        }),
      {
        initialProps: {
          paths: initialPaths as readonly string[],
          pathResetVersion: "sort-1",
        },
      },
    );
    const resetPaths = vi.spyOn(result.current.model, "resetPaths");

    rerender({ paths: [...initialPaths], pathResetVersion: "sort-1" });
    expect(resetPaths).not.toHaveBeenCalled();

    rerender({ paths: [...initialPaths], pathResetVersion: "sort-2" });
    expect(resetPaths).toHaveBeenCalledOnce();
    unmount();
  });
});
