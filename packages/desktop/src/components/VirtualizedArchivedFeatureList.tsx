import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useEffect, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { Feature } from "@/api/generated";
import { ArchivedFeatureSection } from "@/components/ArchivedFeatureList";
import { useMeasuredActiveRange, useVirtualFeatureFocus } from "@/hooks/useVirtualFeatureFocus";

interface SidebarNavigateDetail {
  direction: "up" | "down";
  handled: boolean;
}

interface VirtualizedArchivedFeatureListProps {
  features: readonly Feature[];
  expanded: boolean;
  onToggle: () => void;
  renderFeature: (feature: Feature) => ReactNode;
  activeFeatureId: number | null;
}

export function VirtualizedArchivedFeatureList({
  features,
  expanded,
  onToggle,
  renderFeature,
  activeFeatureId,
}: VirtualizedArchivedFeatureListProps): ReactElement | null {
  const { t } = useUiTranslation();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeIndex = features.findIndex((feature) => feature.id === activeFeatureId);
  const featureIds = useMemo(() => features.map((feature) => feature.id), [features]);
  const { focusIndex, handleRangeChanged } = useVirtualFeatureFocus(
    featureIds,
    rootRef,
    virtuosoRef,
    "data-archived-feature-index",
  );
  const handleMeasuredRange = useMeasuredActiveRange(
    activeIndex,
    activeFeatureId,
    virtuosoRef,
    handleRangeChanged,
    expanded,
  );

  const handleNavigate = useCallback(
    (event: Event): void => {
      const customEvent = event as CustomEvent<SidebarNavigateDetail>;
      const row =
        customEvent.target === rootRef.current
          ? null
          : (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
              "[data-archived-feature-index]",
            );
      const currentIndex =
        row && rootRef.current?.contains(row) ? Number(row.dataset.archivedFeatureIndex) : null;
      const nextIndex =
        currentIndex == null
          ? customEvent.detail.direction === "down"
            ? 0
            : features.length - 1
          : currentIndex + (customEvent.detail.direction === "down" ? 1 : -1);
      if (nextIndex < 0 || nextIndex >= features.length) return;
      customEvent.detail.handled = true;
      focusIndex(nextIndex);
    },
    [features.length, focusIndex],
  );

  useEffect(() => {
    const root = rootRef.current;
    root?.addEventListener("cadencr-sidebar-navigate", handleNavigate);
    return () => root?.removeEventListener("cadencr-sidebar-navigate", handleNavigate);
  }, [expanded, handleNavigate]);

  if (features.length === 0) return null;
  return (
    <ArchivedFeatureSection features={features} expanded={expanded} onToggle={onToggle}>
      <div
        ref={rootRef}
        data-virtual-nav-list
        role="list"
        aria-label={t(
          "sidebar.virtualizedArchivedFeatureList.archivedConversations",
          "Archived conversations",
        )}
      >
        <Virtuoso
          ref={virtuosoRef}
          data={features as Feature[]}
          initialTopMostItemIndex={activeIndex >= 0 ? activeIndex : 0}
          style={{ height: `${Math.min(features.length, 5) * 2.25}rem` }}
          computeItemKey={(_index, feature) => feature.id}
          rangeChanged={handleMeasuredRange}
          increaseViewportBy={72}
          itemContent={(index, feature) => (
            <div role="listitem" data-archived-feature-index={index}>
              {renderFeature(feature)}
            </div>
          )}
        />
      </div>
    </ArchivedFeatureSection>
  );
}
