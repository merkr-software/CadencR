import { BookmarkCheck } from "lucide-react";
import { memo, useCallback, useMemo, type CSSProperties, type ReactElement } from "react";
import { Virtuoso } from "react-virtuoso";

import type { UncommittedFile } from "@/api/generated";
import { groupStashFiles, type UncommittedFileBucket } from "./uncommittedFileGroups";
import { UncommittedFileRow } from "./UncommittedFileRow";

interface StashFileListProps {
  files: UncommittedFile[];
  includeUntracked: boolean;
}

type StashListItem =
  | {
      kind: "group";
      key: string;
      bucket: UncommittedFileBucket;
      label: string;
      count: number;
      excluded: boolean;
    }
  | { kind: "file"; key: string; file: UncommittedFile; excluded: boolean };

function buildStashListItems(files: UncommittedFile[], includeUntracked: boolean): StashListItem[] {
  return groupStashFiles(files).flatMap((group): StashListItem[] => {
    const excluded = group.key === "untracked" && !includeUntracked;
    return [
      {
        kind: "group",
        key: `group-${group.key}`,
        bucket: group.key,
        label: group.label,
        count: group.files.length,
        excluded,
      },
      ...group.files.map((file): StashListItem => ({
        kind: "file",
        key: `${group.key}-${file.path}`,
        file,
        excluded,
      })),
    ];
  });
}

export const StashFileList = memo(function StashFileList({
  files,
  includeUntracked,
}: StashFileListProps): ReactElement {
  const items = useMemo(
    () => buildStashListItems(files, includeUntracked),
    [files, includeUntracked],
  );
  const style = useMemo<CSSProperties>(
    () => ({ height: `min(40vh, ${Math.max(72, items.length * 28)}px)` }),
    [items.length],
  );
  const computeItemKey = useCallback(
    (index: number): string | number => items[index]?.key ?? index,
    [items],
  );
  const itemContent = useCallback(
    (index: number): ReactElement => {
      const item = items[index];
      if (!item) return <div className="h-7" />;
      if (item.kind === "file") {
        return (
          <div role="listitem" className="py-0.5 pr-3">
            <UncommittedFileRow file={item.file} muted={item.excluded} />
          </div>
        );
      }
      return <StashGroupHeading item={item} />;
    },
    [items],
  );

  if (items.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">No changes to stash.</p>;
  }
  return (
    <Virtuoso
      aria-label="Files to stash"
      role="list"
      style={style}
      totalCount={items.length}
      computeItemKey={computeItemKey}
      itemContent={itemContent}
      increaseViewportBy={112}
    />
  );
});

function StashGroupHeading({
  item,
}: {
  item: Extract<StashListItem, { kind: "group" }>;
}): ReactElement {
  return (
    <div className="flex items-center gap-1.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {item.bucket === "staged" || item.bucket === "both" ? (
        <BookmarkCheck className="size-3" />
      ) : null}
      <span>
        {item.label} ({item.count})
      </span>
      {item.bucket === "untracked" ? (
        <span className="font-normal normal-case">· {item.excluded ? "excluded" : "included"}</span>
      ) : null}
    </div>
  );
}
