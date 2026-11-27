import { memo, type ReactElement, type ReactNode } from "react";

import type { UncommittedFile } from "@/api/generated";
import { NumStat } from "@/components/NumStat";
import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";

interface UncommittedFileRowProps {
  file: UncommittedFile;
  control?: ReactNode;
  labelFor?: string;
  muted?: boolean;
}

/** Shared path and numstat row used by commit and stash previews. */
export const UncommittedFileRow = memo(function UncommittedFileRow({
  file,
  control,
  labelFor,
  muted = false,
}: UncommittedFileRowProps): ReactElement {
  const { t } = useUiTranslation();
  const className = cn(
    "flex-1 min-w-0 truncate font-mono text-sm",
    labelFor && "cursor-pointer",
    file.change_kind === "deleted" && "line-through text-muted-foreground",
  );
  const content = (
    <>
      <span className="mr-2 text-xs uppercase text-muted-foreground">
        {file.change_kind.charAt(0)}
      </span>
      {file.path}
    </>
  );

  return (
    <div className={cn("flex min-w-0 items-center gap-2", muted && "opacity-50")}>
      {control}
      {labelFor ? (
        <label htmlFor={labelFor} className={className} title={file.path}>
          {content}
        </label>
      ) : (
        <span className={className} title={file.path}>
          {content}
        </span>
      )}
      <NumStat
        additions={file.additions}
        deletions={file.deletions}
        notice={
          file.line_count_unavailable
            ? t("workspace.git.diff.lineCountUnavailable", "Line count unavailable")
            : undefined
        }
        className="shrink-0 text-xs"
      />
    </div>
  );
});
