import { useEffect, useRef, useState } from "react";
import { toCadencrError, type CadencrError } from "@cadencr/tab-sdk";
import { getFileDiff } from "@cadencr/tab-sdk/api";
import { useTabContext } from "@cadencr/tab-sdk/react";

import { parseUnifiedDiff, type DiffLine } from "./diff";
import type { FileNode } from "./model";
import { changedFilesParams, type Scope } from "./useChangedFiles";

export type DiffState =
  | { status: "loading" }
  | { status: "error"; error: CadencrError }
  | { status: "ready"; lines: DiffLine[] };

/**
 * What the file list knows about one file's content. The list carries no
 * content hash, so its counts and status are the change signal: an edit that
 * keeps them identical shows on the next manual refresh.
 */
function contentSignature(file: FileNode): string {
  return `${file.kind}:${file.staged}:${file.additions}:${file.deletions}`;
}

/**
 * One file's diff, in the same scope as the file list. It refetches when that
 * file's entry in the list changes (or `reloads` is bumped by a manual
 * refresh) — not on every list reload — and keeps the previous lines on
 * screen while the new ones load.
 */
export function useFileDiff(file: FileNode | null, scope: Scope, reloads: number): DiffState {
  const { feature } = useTabContext();
  const [state, setState] = useState<DiffState>({ status: "loading" });
  const shownDiff = useRef<string | null>(null);
  const path = file?.path ?? null;
  const oldPath = file?.oldPath ?? null;
  const signature = file ? contentSignature(file) : null;

  useEffect(() => {
    shownDiff.current = null;
    setState({ status: "loading" });
  }, [path, scope]);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    const base = changedFilesParams(feature.id, scope, feature.baseBranch);
    getFileDiff({ ...base, file_path: path, old_file_path: oldPath ?? undefined }).then(
      ({ diff }) => {
        // Same text as on screen: keep the parsed lines (and their rows).
        if (cancelled || diff === shownDiff.current) return;
        shownDiff.current = diff;
        setState({ status: "ready", lines: parseUnifiedDiff(diff) });
      },
      (error: unknown) => {
        if (cancelled) return;
        shownDiff.current = null;
        setState({ status: "error", error: toCadencrError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [feature.id, feature.baseBranch, scope, path, oldPath, signature, reloads]);

  return state;
}
