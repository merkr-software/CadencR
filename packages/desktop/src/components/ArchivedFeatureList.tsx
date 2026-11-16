import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { FeatureHierarchyGutter } from "@/components/FeatureHierarchyGutter";
import type { Feature } from "@/api/generated";
import { cn } from "@/lib/utils";

interface ArchivedFeatureSectionProps {
  features: readonly Feature[];
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** The fold's name; "Dormant" reuses this section for idle conversations. */
  label?: string;
}

/** A folded group of a project's conversations behind a quiet "Label · N" row. */
export function ArchivedFeatureSection({
  features,
  expanded,
  onToggle,
  children,
  label = "Archived",
}: ArchivedFeatureSectionProps) {
  if (features.length === 0) return null;
  return (
    <>
      <button
        type="button"
        data-feature-fold={label.toLowerCase()}
        aria-expanded={expanded}
        aria-label={`${label} (${features.length})`}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:bg-accent/40 focus-visible:text-foreground"
        onClick={onToggle}
      >
        <FeatureHierarchyGutter>
          <ChevronRightIcon
            className={cn("size-3 transition-transform", expanded && "rotate-90")}
          />
        </FeatureHierarchyGutter>
        <span className="font-medium">{label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground/70">{features.length}</span>
      </button>
      {expanded && children}
    </>
  );
}

export function ArchivedFeatureList({
  features,
  expanded,
  onToggle,
  renderFeature,
}: Omit<ArchivedFeatureSectionProps, "children"> & {
  renderFeature: (feature: Feature) => ReactNode;
}) {
  return (
    <ArchivedFeatureSection features={features} expanded={expanded} onToggle={onToggle}>
      {/* The outer box carries the project's guide segment, which the
          scroller would clip (sidebar-rows.css). */}
      <div>
        <div className="max-h-[calc(5*2.25rem)] overflow-y-auto">
          {features.map((feature) => renderFeature(feature))}
        </div>
      </div>
    </ArchivedFeatureSection>
  );
}
