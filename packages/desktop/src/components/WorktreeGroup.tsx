import type { ReactElement, ReactNode } from "react";
import { GitBranchIcon } from "lucide-react";
import type { Feature } from "@/api/generated";

interface WorktreeGroupProps {
  label: string;
  features: readonly Feature[];
  renderFeature: (feature: Feature) => ReactNode;
}

export function WorktreeGroup({
  label,
  features,
  renderFeature,
}: WorktreeGroupProps): ReactElement {
  return (
    <div className="worktree-group flex flex-col gap-0.5 rounded-md border border-transparent bg-muted/30 p-1">
      <div
        className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground"
        title={label}
      >
        <GitBranchIcon className="size-3 shrink-0 opacity-70" />
        <span className="truncate">{label}</span>
        <span className="shrink-0 opacity-70">({features.length})</span>
      </div>
      {features.map(renderFeature)}
    </div>
  );
}
