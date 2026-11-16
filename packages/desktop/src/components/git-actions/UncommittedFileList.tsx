/**
 * Grouped checkbox list of uncommitted files for `CommitDialog`. Displays one
 * group per status bucket (Staged / Unstaged / Untracked) with a small
 * staged-bookmark icon next to staged files. The dialog owns the selection
 * `Set`; this component is a controlled view.
 */
import { memo, type ReactElement } from "react";
import { BookmarkCheck } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { UncommittedFile } from "@/api/generated";
import { groupUncommittedFiles } from "./uncommittedFileGroups";
import { UncommittedFileRow } from "./UncommittedFileRow";

interface UncommittedFileListProps {
  files: UncommittedFile[];
  selected: Set<string>;
  onToggle: (path: string) => void;
}

export const UncommittedFileList = memo(function UncommittedFileList({
  files,
  selected,
  onToggle,
}: UncommittedFileListProps): ReactElement {
  const groups = groupUncommittedFiles(files);
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No uncommitted files.</p>;
  }
  return (
    // `pr-3` reserves a gutter for the overlay scrollbar so it doesn't
    // sit on top of the per-row `<NumStat>` badges. `pr-1` (the previous
    // value) was narrower than the macOS scrollbar in practice.
    <div className="space-y-3 max-h-[calc(var(--app-vh)*0.4)] overflow-y-auto pr-3">
      {groups.map((group) => (
        <div key={group.key}>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">
            {group.key === "staged" && <BookmarkCheck className="size-3" />}
            <span>
              {group.label} ({group.files.length})
            </span>
          </div>
          <ul className="space-y-1">
            {group.files.map((file) => {
              const id = `commit-file-${group.key}-${file.path}`;
              return (
                <li key={id}>
                  <UncommittedFileRow
                    file={file}
                    labelFor={id}
                    control={
                      <Checkbox
                        id={id}
                        checked={selected.has(file.path)}
                        onCheckedChange={() => onToggle(file.path)}
                      />
                    }
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
});
