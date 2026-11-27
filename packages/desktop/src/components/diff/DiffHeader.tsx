import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement, ReactNode } from "react";
import { FileText } from "lucide-react";
import { NumStat } from "@/components/NumStat";

interface DiffHeaderProps {
  fileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  children?: ReactNode;
}

/**
 * Header bar for the diff viewer showing file count and aggregate change counters.
 */
export function DiffHeader({
  fileCount,
  totalAdditions,
  totalDeletions,
  children,
}: DiffHeaderProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-2 text-sm text-foreground">
      <FileText className="h-4 w-4 text-muted-foreground" />
      <span>
        {t("workspace.git.diffHeader.filesChanged", "{{count, number}} files changed", {
          count: fileCount,
          defaultValue_zero: "{{count, number}} files changed",
          defaultValue_one: "{{count, number}} file changed",
        })}
      </span>
      <NumStat additions={totalAdditions} deletions={totalDeletions} hideZero={false} />
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}
