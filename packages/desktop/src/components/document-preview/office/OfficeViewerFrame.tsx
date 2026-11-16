/**
 * The ooxml-backed renderers' mount point, with loading / error overlays.
 */
import type { KeyboardEvent, ReactElement, RefObject } from "react";
import { DocumentError, DocumentLoading } from "../DocumentChrome";
import type { OfficeViewerState } from "./useOfficeViewer";

export function OfficeViewerFrame<V>({
  containerRef,
  state,
  loadingLabel,
  onKeyDown,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  state: OfficeViewerState<V>;
  loadingLabel: string;
  /** Keyboard navigation while focus is inside the document. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}): ReactElement {
  return (
    <div className="relative min-h-0 flex-1 outline-none" onKeyDown={onKeyDown}>
      {/* Laid out while loading: the viewer fits pages to the measured width. */}
      <div
        ref={containerRef}
        className={state.status === "ready" ? "absolute inset-0" : "invisible absolute inset-0"}
      />
      {state.status !== "ready" && (
        <div className="absolute inset-0">
          {state.status === "error" ? (
            <DocumentError message={state.message} />
          ) : (
            <DocumentLoading label={loadingLabel} />
          )}
        </div>
      )}
    </div>
  );
}
