import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
import {
  ClipboardCopyIcon,
  EyeIcon,
  FilePlusIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { ContextMenuActionButton, type ContextMenuIcon } from "@/components/ContextMenuActionItem";
import { FileTreeContextMenuPortal } from "@/components/file-tree/FileTreeContextMenuPortal";
import { isDocumentFile } from "@/lib/document-file";
import type { ShortcutKey } from "@/lib/shortcuts/registry";

// Mirrors the tree's plain-Enter rename handler (`useFileTreeController`).
const RENAME_KEYS: ShortcutKey[] = ["enter"];
// Mirrors the tree's Mod+Backspace handler (`useFileTreeController`).
const MOVE_TO_TRASH_KEYS: ShortcutKey[] = ["mod", "backspace"];

export type FileTreeContextMenuItem = ContextMenuItem;
export type FileTreeContextMenuOpenContext = ContextMenuOpenContext;
export type FileTreeMenuAction =
  | "new-file"
  | "new-folder"
  | "open"
  | "open-preview"
  | "copy-path"
  | "reveal"
  | "rename"
  | "delete";

interface MenuItemSpec {
  label: string;
  icon: ContextMenuIcon;
  shortcut?: ShortcutKey[];
  destructive?: boolean;
  onSelect: () => void;
}

interface FileTreeContextMenuProps {
  item: FileTreeContextMenuItem;
  context: FileTreeContextMenuOpenContext;
  /**
   * Called with a verb-keyed action when the user picks a menu item. The
   * caller is responsible for closing pierre's context menu via
   * `context.close()` — typically done from inside the action handler before
   * opening a follow-up dialog or popover.
   */
  onAction: (
    action: FileTreeMenuAction,
    item: FileTreeContextMenuItem,
    context: FileTreeContextMenuOpenContext,
  ) => void;
}

/**
 * Build the menu spec for an item — files get an `Open` entry (and documents
 * an `Open in Preview` one), directories skip them. Order matches the user's expected verb sequence.
 */
function buildMenuItems(
  item: FileTreeContextMenuItem,
  context: FileTreeContextMenuOpenContext,
  onAction: FileTreeContextMenuProps["onAction"],
): MenuItemSpec[] {
  const isDir = item.kind === "directory";
  const items: MenuItemSpec[] = [
    { label: "New File…", icon: FilePlusIcon, onSelect: () => onAction("new-file", item, context) },
    {
      label: "New Folder…",
      icon: FolderPlusIcon,
      onSelect: () => onAction("new-folder", item, context),
    },
  ];
  if (!isDir) {
    items.push({
      label: "Open",
      icon: FolderOpenIcon,
      onSelect: () => onAction("open", item, context),
    });
  }
  if (!isDir && isDocumentFile(item.path)) {
    items.push({
      label: "Open in Preview",
      icon: EyeIcon,
      onSelect: () => onAction("open-preview", item, context),
    });
  }
  items.push(
    {
      label: "Copy Path",
      icon: ClipboardCopyIcon,
      onSelect: () => onAction("copy-path", item, context),
    },
    {
      label: "Reveal in File Manager",
      icon: FolderOpenIcon,
      onSelect: () => onAction("reveal", item, context),
    },
    {
      label: "Rename",
      icon: PencilIcon,
      shortcut: RENAME_KEYS,
      onSelect: () => onAction("rename", item, context),
    },
    {
      label: "Move to Trash",
      icon: Trash2Icon,
      shortcut: MOVE_TO_TRASH_KEYS,
      destructive: true,
      onSelect: () => onAction("delete", item, context),
    },
  );
  return items;
}

/**
 * Pierre renders our menu inside its own positioned slot, which lives in
 * the same stacking context as the file tree — that means the editor (and
 * any panel with `position: relative`) can paint on top of it, and the
 * menu can spill below the viewport. We bypass both problems by
 * portalling to `document.body` and computing our own position from
 * pierre's `anchorRect`, flipping when the menu would overflow.
 */
export function FileTreeContextMenu({
  item,
  context,
  onAction,
}: FileTreeContextMenuProps): React.JSX.Element {
  const items = buildMenuItems(item, context, onAction);
  // The shortcut hints in the menu (↵, ⌘⌫) are served by the tree-level
  // key handler in `FileTree.tsx`, which already binds these to the
  // focused row. We deliberately don't add a document-level listener
  // here — it would race with the tree handler and fire the action twice.

  return (
    <FileTreeContextMenuPortal context={context}>
      {items.map((entry, index) => (
        <MenuRow
          key={`${index}-${entry.label}`}
          label={entry.label}
          icon={entry.icon}
          shortcut={entry.shortcut}
          destructive={entry.destructive}
          onSelect={entry.onSelect}
        />
      ))}
    </FileTreeContextMenuPortal>
  );
}

function MenuRow({
  label,
  icon,
  shortcut,
  destructive,
  onSelect,
}: {
  label: string;
  icon: ContextMenuIcon;
  shortcut?: ShortcutKey[];
  destructive?: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <ContextMenuActionButton
      icon={icon}
      shortcutKeys={shortcut}
      destructive={destructive}
      className="py-1"
      onSelect={onSelect}
    >
      {label}
    </ContextMenuActionButton>
  );
}
