import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { KindSwatch, LineCounts } from "./kind";
import { KINDS, type FileNode } from "./model";

export interface Inspected {
  file: FileNode;
  at: { x: number; y: number };
}

/**
 * The hovered (or focused) tile, outside React state: tiles report the
 * pointer through a stable `inspect`, at most once per frame, and only the
 * tooltip subscribes. Hovering re-renders the tooltip, never the treemap.
 */
export interface Inspector {
  inspect(next: Inspected | null): void;
  subscribe(listener: () => void): () => void;
  current(): Inspected | null;
}

export function createInspector(): Inspector {
  let current: Inspected | null = null;
  let pending: Inspected | null = null;
  let frame = 0;
  const listeners = new Set<() => void>();
  return {
    inspect(next) {
      pending = next;
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        current = pending;
        for (const listener of listeners) listener();
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => current,
  };
}

const OFFSET = 12;
const MARGIN = 8;

/** Follows the pointer (or sits under the focused tile), clamped to the viewport. */
export function FileTooltip({ inspector }: { inspector: Inspector }) {
  const inspected = useSyncExternalStore(inspector.subscribe, inspector.current);
  const ref = useRef<HTMLDivElement>(null);

  // Placed by writing the style directly: one commit per frame, no second
  // render to apply a measured position.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !inspected) return;
    const { x, y } = inspected.at;
    const box = element.getBoundingClientRect();
    const fitsRight = x + OFFSET + box.width + MARGIN <= window.innerWidth;
    const fitsBelow = y + OFFSET + box.height + MARGIN <= window.innerHeight;
    element.style.left = `${Math.max(MARGIN, fitsRight ? x + OFFSET : x - OFFSET - box.width)}px`;
    element.style.top = `${Math.max(MARGIN, fitsBelow ? y + OFFSET : y - OFFSET - box.height)}px`;
    element.style.visibility = "visible";
  }, [inspected]);

  if (!inspected) return null;
  const { file } = inspected;
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none invisible fixed top-0 left-0 z-50 flex max-w-80 flex-col gap-1 rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md"
    >
      <span className="font-mono text-[11px] break-all">{file.path}</span>
      {file.oldPath && file.oldPath !== file.path ? (
        <span className="font-mono text-[11px] break-all text-muted-foreground">
          from {file.oldPath}
        </span>
      ) : null}
      <span className="flex items-center gap-2 text-xs">
        <KindSwatch kind={file.kind} />
        <span>{KINDS[file.kind].label}</span>
        {file.staged ? <span className="text-muted-foreground">· staged</span> : null}
        <LineCounts
          additions={file.additions}
          deletions={file.deletions}
          className="ml-auto text-[11px]"
        />
      </span>
    </div>
  );
}
