import { memo } from "react";
import { Button, cn } from "@cadencr/tab-kit";

import { KindSwatch, LineCounts } from "./kind";
import { KINDS, dirLabel, type DirGroup, type FileNode } from "./model";

interface FileListProps {
  groups: DirGroup[];
  selectedPath: string | null;
  /** Open the file's diff; `origin` gets focus back when the panel closes. */
  onOpen: (file: FileNode, origin: HTMLElement) => void;
}

/**
 * The same data as the treemap, as rows: directory headings, then one row per
 * file with a bar proportional to its changed lines (split +/−). Reads well
 * in a narrow pane and with a screen reader.
 */
export const FileList = memo(function FileList({ groups, selectedPath, onOpen }: FileListProps) {
  const max = Math.max(1, ...groups.flatMap((group) => group.files.map((file) => file.weight)));
  return (
    <div className="flex flex-col gap-3 px-2 py-3">
      {groups.map((group) => (
        <section key={group.dir} aria-label={dirLabel(group.dir)}>
          <h2 className="mb-1 flex items-center justify-between px-2 font-mono text-[11px] text-muted-foreground">
            <span className="truncate">{dirLabel(group.dir)}</span>
            <LineCounts additions={group.additions} deletions={group.deletions} />
          </h2>
          <ul className="flex flex-col">
            {group.files.map((file) => (
              <li key={file.path}>
                <Button
                  variant="ghost"
                  data-path={file.path}
                  aria-pressed={file.path === selectedPath}
                  onClick={(event) => onOpen(file, event.currentTarget)}
                  className={cn(
                    "grid h-auto w-full grid-cols-[auto_minmax(0,1fr)_minmax(48px,30%)_11ch] gap-3 px-2 py-1.5 text-left text-xs font-normal",
                    file.path === selectedPath && "bg-accent",
                  )}
                >
                  <span className="flex items-center gap-1.5" title={KINDS[file.kind].label}>
                    <KindSwatch kind={file.kind} />
                    <span className="w-2 font-mono text-[10px] text-muted-foreground">
                      {KINDS[file.kind].glyph}
                    </span>
                    <span className="sr-only">{KINDS[file.kind].label}</span>
                  </span>
                  <span className="truncate">{file.name}</span>
                  <span
                    aria-hidden="true"
                    className="flex h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="bg-numstat-add-fg"
                      style={{ width: `${(file.additions / max) * 100}%` }}
                    />
                    <span
                      className="bg-numstat-del-fg"
                      style={{ width: `${(file.deletions / max) * 100}%` }}
                    />
                  </span>
                  <LineCounts
                    additions={file.additions}
                    deletions={file.deletions}
                    tone="muted"
                    className="text-right text-[11px] text-muted-foreground"
                  />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
});
