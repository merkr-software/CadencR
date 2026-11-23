import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import {
  FileTreeContextMenu,
  type FileTreeContextMenuItem,
  type FileTreeContextMenuOpenContext,
} from "./FileTreeContextMenu";

function makeContext(): FileTreeContextMenuOpenContext {
  return {
    anchorRect: { left: 10, right: 20, top: 10, bottom: 20, width: 10, height: 10 },
    close: vi.fn(),
  } as unknown as FileTreeContextMenuOpenContext;
}

function makeItem(
  kind: "file" | "directory",
  path = "packages/desktop/src/foo.ts",
): FileTreeContextMenuItem {
  return { kind, path } as unknown as FileTreeContextMenuItem;
}

describe("FileTreeContextMenu Copy Path", () => {
  it("renders a Copy Path item for files and routes it to the copy-path action", () => {
    const onAction = vi.fn();
    const item = makeItem("file");
    const context = makeContext();
    render(<FileTreeContextMenu item={item} context={context} onAction={onAction} />);

    const copyPath = screen.getByRole("menuitem", { name: "Copy Path" });
    fireEvent.click(copyPath);

    expect(onAction).toHaveBeenCalledWith("copy-path", item, context);
  });

  it("offers Copy Path for directories too", () => {
    const onAction = vi.fn();
    render(
      <FileTreeContextMenu
        item={makeItem("directory")}
        context={makeContext()}
        onAction={onAction}
      />,
    );
    expect(screen.getByRole("menuitem", { name: "Copy Path" })).toBeInTheDocument();
  });
});

describe("FileTreeContextMenu Open in Preview", () => {
  it("offers a preview for a document whose escaped name holds a newline", () => {
    render(
      <FileTreeContextMenu
        item={makeItem("file", 'docs/"a\\nb.pdf"')}
        context={makeContext()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("menuitem", { name: "Open in Preview" })).toBeInTheDocument();
  });
});
