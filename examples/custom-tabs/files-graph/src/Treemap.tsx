import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { FileTooltip, createInspector, type Inspector } from "./FileTooltip";
import { kindStyle, LineCounts } from "./kind";
import { KINDS, dirLabel, type DirGroup, type FileNode } from "./model";
import { inset, squarify, type Rect } from "./squarify";

const GROUP_GAP = 3;
const TILE_GAP = 1;
const GROUP_HEADER = 20;

/** The element's size, updated at most once per frame while it resizes. */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    let measured = false;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      const apply = () =>
        setSize((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
      // The first size lands before paint; a drag-resize re-lays out once per frame.
      if (!measured) {
        measured = true;
        apply();
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  return { ref, size };
}

interface GroupLayout {
  group: DirGroup;
  frame: Rect;
  showHeader: boolean;
  tiles: { file: FileNode; rect: Rect }[];
}

function layout(groups: DirGroup[], width: number, height: number): GroupLayout[] {
  const bounds = { x: 0, y: 0, width, height };
  return squarify(groups, (group) => group.weight, bounds).map(({ item: group, rect }) => {
    const frame = inset(rect, GROUP_GAP / 2);
    const showHeader = frame.height >= GROUP_HEADER * 2.2 && frame.width >= 72;
    const body = inset(
      {
        x: frame.x,
        y: frame.y + (showHeader ? GROUP_HEADER : 0),
        width: frame.width,
        height: frame.height - (showHeader ? GROUP_HEADER : 0),
      },
      2,
    );
    const tiles = squarify(group.files, (file) => file.weight, body).map(
      ({ item: file, rect: tile }) => ({ file, rect: inset(tile, TILE_GAP) }),
    );
    return { group, frame, showHeader, tiles };
  });
}

const position = (rect: Rect): CSSProperties => ({
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
});

interface TileProps {
  file: FileNode;
  rect: Rect;
  selected: boolean;
  onOpen: (file: FileNode, origin: HTMLElement) => void;
  inspect: Inspector["inspect"];
}

/** Memoized: a refresh that keeps a file's entry and rect re-renders nothing. */
const Tile = memo(function Tile({ file, rect, selected, onOpen, inspect }: TileProps) {
  const kind = KINDS[file.kind];
  const roomy = rect.width >= 64 && rect.height >= 38;
  const lines = file.additions + file.deletions;
  return (
    <button
      type="button"
      data-path={file.path}
      data-kind={file.kind}
      data-selected={selected}
      aria-label={`${file.path}, ${kind.label}, ${file.additions} added, ${file.deletions} removed`}
      aria-pressed={selected}
      onClick={(event) => {
        inspect(null);
        onOpen(file, event.currentTarget);
      }}
      onPointerMove={(event) => inspect({ file, at: { x: event.clientX, y: event.clientY } })}
      onPointerLeave={() => inspect(null)}
      onFocus={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        inspect({ file, at: { x: box.left + box.width / 2, y: box.bottom } });
      }}
      onBlur={() => inspect(null)}
      className="kind-tile absolute flex flex-col justify-between overflow-hidden rounded-[4px] p-1.5 text-left outline-none motion-safe:transition-[left,top,width,height,background-color,border-color] motion-safe:duration-200"
      style={{ ...position(rect), ...kindStyle(file.kind) }}
    >
      {rect.width >= 22 && rect.height >= 18 ? (
        <span className="absolute top-1 right-1.5 font-mono text-[10px] leading-none text-foreground/70">
          {kind.glyph}
        </span>
      ) : null}
      {roomy ? (
        <>
          <span className="truncate pr-3 text-xs leading-tight font-medium">{file.name}</span>
          <LineCounts
            additions={file.additions}
            deletions={file.deletions}
            tone="muted"
            className="text-[10.5px] leading-none text-muted-foreground"
          />
        </>
      ) : null}
      {rect.height >= 26 && lines > 0 ? (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 flex h-0.5">
          <span className="bg-numstat-add-fg" style={{ flexGrow: file.additions }} />
          <span className="bg-numstat-del-fg" style={{ flexGrow: file.deletions }} />
        </span>
      ) : null}
    </button>
  );
});

interface TreemapProps {
  groups: DirGroup[];
  selectedPath: string | null;
  /** Open the file's diff; `origin` gets focus back when the panel closes. */
  onOpen: (file: FileNode, origin: HTMLElement) => void;
}

/** Directory-grouped squarified treemap; each file's area is its changed lines. */
export const Treemap = memo(function Treemap({ groups, selectedPath, onOpen }: TreemapProps) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const [inspector] = useState(createInspector);
  const layouts = useMemo(
    () => (size.width > 0 && size.height > 0 ? layout(groups, size.width, size.height) : []),
    [groups, size.width, size.height],
  );
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Changed files by directory"
      className="relative h-full w-full"
    >
      {layouts.map(({ group, frame, showHeader, tiles }) => (
        <div key={group.dir} role="group" aria-label={dirLabel(group.dir)}>
          <div
            aria-hidden="true"
            className="absolute rounded-md border border-border/60 bg-surface-sunken"
            style={position(frame)}
          >
            {showHeader ? (
              <div className="flex h-5 items-center justify-between gap-2 px-2 font-mono text-[10.5px] text-muted-foreground">
                <span className="truncate">{dirLabel(group.dir)}</span>
                <span className="shrink-0 tabular-nums">{group.files.length}</span>
              </div>
            ) : null}
          </div>
          {tiles.map(({ file, rect }) => (
            <Tile
              key={file.path}
              file={file}
              rect={rect}
              selected={file.path === selectedPath}
              onOpen={onOpen}
              inspect={inspector.inspect}
            />
          ))}
        </div>
      ))}
      <FileTooltip inspector={inspector} />
    </div>
  );
});
