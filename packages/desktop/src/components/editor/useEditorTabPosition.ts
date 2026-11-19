import { useMemo } from "react";
import { useEditorStore } from "@/stores/editor-store";

export function useEditorTabPosition(props: {
  featureId: number;
  paneId: string;
  filePath: string;
}) {
  const cursorPosition = useEditorStore(
    (state) =>
      state.features[props.featureId]?.panes[props.paneId]?.tabs.find(
        (candidate) => candidate.filePath === props.filePath,
      )?.cursorPosition,
  );
  const pendingGoToLine = useEditorStore(
    (state) =>
      state.features[props.featureId]?.panes[props.paneId]?.tabs.find(
        (candidate) => candidate.filePath === props.filePath,
      )?.pendingGoToLine,
  );
  const pendingGoToColumn = useEditorStore(
    (state) =>
      state.features[props.featureId]?.panes[props.paneId]?.tabs.find(
        (candidate) => candidate.filePath === props.filePath,
      )?.pendingGoToColumn,
  );
  return useMemo(
    () => ({ cursorPosition, pendingGoToLine, pendingGoToColumn }),
    [cursorPosition, pendingGoToLine, pendingGoToColumn],
  );
}
