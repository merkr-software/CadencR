import type { CSSProperties } from "react";
import { cn } from "@cadencr/tab-kit";

import { KINDS, formatCount, type FileKind } from "./model";

/** Sets `--kind` to the kind's theme token; index.css tints from it. */
export function kindStyle(kind: FileKind): CSSProperties {
  return { "--kind": `var(${KINDS[kind].token})` } as CSSProperties;
}

export function KindSwatch({ kind, className }: { kind: FileKind; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-kind={kind}
      className={cn("kind-swatch inline-block size-2.5 shrink-0 rounded-[3px]", className)}
      style={kindStyle(kind)}
    />
  );
}

interface LineCountsProps {
  additions: number;
  deletions: number;
  /** `muted` drops the add/delete colors (e.g. on a tinted tile). */
  tone?: "color" | "muted";
  className?: string;
}

/** "+12 −3", in the desktop's line-count colors. */
export function LineCounts({ additions, deletions, tone = "color", className }: LineCountsProps) {
  const colored = tone === "color";
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      <span className={cn(colored && "text-numstat-add-fg")}>+{formatCount(additions)}</span>{" "}
      <span className={cn(colored && "text-numstat-del-fg")}>−{formatCount(deletions)}</span>
    </span>
  );
}
