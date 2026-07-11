import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { Feature } from "@/api/generated";

export function ArchivedFeatureList({
  features,
  expanded,
  onToggle,
  renderFeature,
}: {
  features: readonly Feature[];
  expanded: boolean;
  onToggle: () => void;
  renderFeature: (feature: Feature) => ReactNode;
}) {
  if (features.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={onToggle}
      >
        <span className="flex-1 border-t border-border/50" />
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        <span className="shrink-0">Archived ({features.length})</span>
        <span className="flex-1 border-t border-border/50" />
      </button>
      {expanded && (
        <div className="max-h-[calc(5*2.25rem)] overflow-y-auto">
          {features.map((feature) => renderFeature(feature))}
        </div>
      )}
    </>
  );
}
