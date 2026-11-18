// @vitest-environment happy-dom
import { FileTree, type FileTreeDirectoryHandle } from "@pierre/trees";
import { describe, expect, it, vi } from "vitest";
import { buildPierreInputs } from "./cadencrFileTreeModel";
import { revealInFileTree } from "./revealInFileTree";

describe("revealInFileTree", () => {
  it("reveals a file whose names hold control characters from its real path", () => {
    const { paths } = buildPierreInputs([
      { path: "dir\tx", is_dir: true, is_gitignored: false },
      { path: "dir\tx/a\nb.txt", is_dir: false, is_gitignored: false },
    ]);
    const model = new FileTree({ paths, initialExpansion: "closed" });
    const ensureDirLoaded = vi.fn();

    expect(revealInFileTree(model, "dir\tx/a\nb.txt", ensureDirLoaded)).toBe(true);
    const dir = model.getItem('"dir\\tx"/') as FileTreeDirectoryHandle;
    expect(dir.isExpanded()).toBe(true);
    expect(ensureDirLoaded).not.toHaveBeenCalled();
  });

  it("asks a lazy tree for the real ancestor folders", () => {
    const model = new FileTree({ paths: [], initialExpansion: "closed" });
    const ensureDirLoaded = vi.fn();

    expect(revealInFileTree(model, "dir\tx/a\nb.txt", ensureDirLoaded)).toBe(false);
    expect(ensureDirLoaded).toHaveBeenCalledWith("dir\tx");
  });
});
