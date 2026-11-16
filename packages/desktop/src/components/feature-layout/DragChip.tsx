import type { ReactNode } from "react";

import { FeatureTabIcon } from "./FeatureTabIcon";
import type { FeatureTabs } from "./types";
import type { TabKind } from "@/stores/feature-layout-schema";

interface DragChipProps {
  tab: TabKind;
  tabs: FeatureTabs;
}

/**
 * Floating chip rendered inside `<DragOverlay>` while a tab is being dragged.
 * Mirrors the look of an active tab trigger so the user gets a clear visual
 * tether between cursor and dropped destination.
 */
export function DragChip({ tab, tabs }: DragChipProps): ReactNode {
  const def = tabs[tab];
  if (!def) return null;
  return (
    <div className="pointer-events-none flex h-9 items-center gap-1.5 rounded border border-primary bg-background px-3 py-2 text-xs font-semibold text-foreground shadow-lg">
      <FeatureTabIcon def={def} />
      <span>{def.label}</span>
    </div>
  );
}
