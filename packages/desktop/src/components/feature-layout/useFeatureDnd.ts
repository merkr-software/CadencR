import { useCallback } from "react";
import {
  PointerSensor,
  pointerWithin,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import type { TabKind } from "@/stores/feature-layout-schema";

import type { DragSource, DropTarget } from "./types";

interface UseFeatureDndArgs {
  featureId: number;
  onDragStart: (source: DragSource | null) => void;
  onDragEnd: () => void;
}

interface UseFeatureDndResult {
  sensors: ReturnType<typeof useSensors>;
  collisionDetection: typeof pointerWithin;
  handleDragStart: (e: DragStartEvent) => void;
  handleDragEnd: (e: DragEndEvent) => void;
  handleDragCancel: () => void;
}

/**
 * Wires up `@dnd-kit/core` to the feature-layout store. Translates each
 * (source × target) pair into the right store mutation:
 *
 *   pane → pane-edge   ⇒ splitTabAt    (split target along that edge)
 *   pane → pane-strip  ⇒ moveTabToPane (append into target's tab list)
 */
export function useFeatureDnd({
  featureId,
  onDragStart,
  onDragEnd,
}: UseFeatureDndArgs): UseFeatureDndResult {
  // 6px activation distance keeps click-to-activate intact.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const splitTabAt = useFeatureLayoutStore((s) => s.splitTabAt);
  const moveTabToPane = useFeatureLayoutStore((s) => s.moveTabToPane);

  const handleDragStart = useCallback(
    (e: DragStartEvent) => {
      const data = e.active.data.current as DragSource | undefined;
      onDragStart(data ?? null);
    },
    [onDragStart],
  );

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      onDragEnd();
      const source = e.active.data.current as DragSource | undefined;
      const target = e.over?.data.current as DropTarget | undefined;
      if (!source || !target) return;
      if (source.kind !== "pane") return;

      const tab: TabKind = source.tab;
      switch (target.kind) {
        case "pane-edge":
          noteUserLayoutChange(featureId, { structural: true });
          splitTabAt(featureId, tab, target.paneId, target.edge);
          break;
        case "pane-strip":
          if (source.paneId === target.paneId) return; // no-op (drag onto own strip)
          noteUserLayoutChange(featureId, { structural: true });
          moveTabToPane(featureId, tab, target.paneId);
          break;
      }
    },
    [featureId, moveTabToPane, onDragEnd, splitTabAt],
  );

  const handleDragCancel = useCallback(() => onDragEnd(), [onDragEnd]);

  return {
    sensors,
    collisionDetection: pointerWithin,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  };
}
