import { useEffect, useRef } from "react";
import { FileIcon, FolderIcon } from "lucide-react";
import { ComposerPopover, ComposerPopoverOption } from "./composer/ComposerPopover";

interface FileMentionItem {
  path: string;
  isDir: boolean;
}

interface FileMentionPopoverProps {
  listId: string;
  items: FileMentionItem[];
  selectedIndex: number;
  onSelect: (path: string) => void;
  maxHeight?: number;
}

/** `dir/sub/` + `name`, so the name leads and the location stays legible. */
function splitPath(path: string): { dir: string; name: string } {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1
    ? { dir: "", name: trimmed }
    : { dir: trimmed.slice(0, slash + 1), name: trimmed.slice(slash + 1) };
}

export function FileMentionPopover({
  listId,
  items,
  selectedIndex,
  onSelect,
  maxHeight,
}: FileMentionPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const selected = listRef.current?.querySelector("[data-selected='true']");
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <ComposerPopover ref={listRef} listId={listId} label="Files" maxHeight={maxHeight}>
      {items.map((item, index) => {
        const { dir, name } = splitPath(item.path);
        const Icon = item.isDir ? FolderIcon : FileIcon;
        return (
          <ComposerPopoverOption
            key={item.path}
            listId={listId}
            index={index}
            selected={index === selectedIndex}
            title={item.path}
            onSelect={() => onSelect(item.path)}
          >
            <Icon className="size-3.5 shrink-0 text-[var(--acc-cyan)]" />
            <span className="shrink-0 font-medium">
              {name}
              {item.isDir ? "/" : ""}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="rtl">
              {/* rtl truncation keeps the deepest folders visible */}
              <bdi>{dir}</bdi>
            </span>
          </ComposerPopoverOption>
        );
      })}
    </ComposerPopover>
  );
}
