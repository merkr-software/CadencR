import { memo, useEffect, useRef, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { Button, EmptyState, Skeleton, cn } from "@cadencr/tab-kit";

import type { DiffLine } from "./diff";
import { KindSwatch, LineCounts } from "./kind";
import { KINDS, dirLabel, formatCount, type FileNode } from "./model";
import type { DiffState } from "./useFileDiff";

/** Lockfiles and generated files can reach tens of thousands of lines: render
 *  this many until the user asks for the rest. */
const LINE_CAP = 2_000;

const SIGN: Record<DiffLine["kind"], string> = {
  add: "+",
  del: "−",
  context: " ",
  hunk: "",
  meta: "",
};

const ROW_TINT: Record<DiffLine["kind"], string> = {
  add: "bg-diff-add-bg",
  del: "bg-diff-del-bg",
  context: "",
  hunk: "diff-hunk",
  meta: "",
};

const DiffRow = memo(function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "hunk" || line.kind === "meta") {
    return <div className={cn("px-3 py-0.5 text-muted-foreground", ROW_TINT[line.kind])}>{line.text}</div>;
  }
  return (
    <div className={cn("grid grid-cols-[3.5ch_3.5ch_2ch_1fr]", ROW_TINT[line.kind])}>
      <span className="pr-1 text-right text-muted-foreground/70 select-none">
        {line.oldNumber ?? ""}
      </span>
      <span className="pr-1 text-right text-muted-foreground/70 select-none">
        {line.newNumber ?? ""}
      </span>
      <span
        className={cn(
          "text-center select-none",
          line.kind === "add" && "text-numstat-add-fg",
          line.kind === "del" && "text-numstat-del-fg",
        )}
      >
        {SIGN[line.kind]}
      </span>
      <span className="pr-3 whitespace-pre-wrap break-all">{line.text}</span>
    </div>
  );
});

function DiffLines({ lines }: { lines: DiffLine[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? lines : lines.slice(0, LINE_CAP);
  return (
    <div className="min-w-0 py-2 font-mono text-[11.5px] leading-[1.65]">
      {shown.map((line, index) => (
        <DiffRow key={index} line={line} />
      ))}
      {shown.length < lines.length ? (
        <div className="flex items-center gap-3 px-3 pt-3 font-sans text-xs text-muted-foreground">
          <span>
            Showing {formatCount(shown.length)} of {formatCount(lines.length)} lines.
          </span>
          <Button variant="outline" size="xs" onClick={() => setShowAll(true)}>
            Show all
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const DiffBody = memo(function DiffBody({ state }: { state: DiffState }) {
  if (state.status === "loading") {
    return (
      <div role="status" className="flex flex-col gap-2 p-3">
        <span className="sr-only">Loading the diff…</span>
        {[72, 54, 88, 40, 66, 80, 35].map((width, index) => (
          <Skeleton key={index} aria-hidden="true" className="h-3" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <EmptyState
        icon={<TriangleAlert />}
        title="Couldn't load the diff"
        description={state.error.message}
      />
    );
  }
  if (state.lines.length === 0) {
    return (
      <EmptyState
        title="No textual changes"
        description="Git reports no line changes for this file."
      />
    );
  }
  return <DiffLines lines={state.lines} />;
});

interface DiffPanelProps {
  file: FileNode;
  state: DiffState;
  onClose: () => void;
}

/** The selected file's unified diff. Esc closes it (handled by the app). */
export const DiffPanel = memo(function DiffPanel({ file, state, onClose }: DiffPanelProps) {
  const ref = useRef<HTMLElement>(null);
  // Move focus into the panel when it opens on a new file so screen readers
  // announce it; Esc returns focus to the tile.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [file.path]);

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-labelledby="diff-panel-title"
      className="flex min-h-0 w-[min(48%,640px)] min-w-72 shrink-0 flex-col border-l max-sm:absolute max-sm:inset-0 max-sm:w-full max-sm:min-w-0 max-sm:border-l-0 border-border/60 bg-background outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-2 motion-safe:duration-150"
    >
      <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2.5">
        <KindSwatch kind={file.kind} className="mt-1" />
        <div className="min-w-0 flex-1">
          <h2 id="diff-panel-title" className="truncate text-sm leading-tight font-semibold">
            {file.name}
          </h2>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {file.oldPath && file.oldPath !== file.path
              ? `${file.oldPath} → `
              : `${dirLabel(file.dir)} · `}
            {KINDS[file.kind].label}
            {" · "}
            <LineCounts additions={file.additions} deletions={file.deletions} />
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close diff (Esc)"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="diff-surface min-h-0 flex-1 overflow-auto">
        {/* Keyed by file so "Show all" resets when another file opens. */}
        <DiffBody key={file.path} state={state} />
      </div>
    </aside>
  );
});
