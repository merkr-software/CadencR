import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { useGetFileDiff } from "@/api/generated";
import { isBinaryPatch, parseUnifiedDiff, type FileDiffSection } from "@/lib/parse-unified-diff";
import { LARGE_DIFF_BYTES } from "@/lib/diff-thresholds";
import { apiErrorMessage, retryUnlessRefusedForSize } from "@/lib/api-errors";
import type { DiffMode } from "./useDiffData";

const EMPTY_SECTION: FileDiffSection = {
  oldFileName: "/dev/null",
  newFileName: "/dev/null",
  hunks: [],
};

type LargeDiffOptInState =
  | { kind: "none" }
  | { kind: "pending"; scopeKey: string }
  | { kind: "accepted"; scopeKey: string; raw: string };

const NO_OPT_IN: LargeDiffOptInState = { kind: "none" };

function reconcileOptInForRaw(
  optIn: LargeDiffOptInState,
  scopeKey: string,
  raw: string | undefined,
): { optedIn: boolean; nextState: LargeDiffOptInState | null } {
  if (optIn.kind === "none") return { optedIn: false, nextState: null };
  if (optIn.scopeKey !== scopeKey) return { optedIn: false, nextState: NO_OPT_IN };
  if (optIn.kind === "pending") {
    return raw === undefined
      ? { optedIn: true, nextState: null }
      : { optedIn: true, nextState: { kind: "accepted", scopeKey, raw } };
  }
  return raw === optIn.raw
    ? { optedIn: true, nextState: null }
    : { optedIn: false, nextState: NO_OPT_IN };
}

export interface FileDiffSectionResult {
  /** Parsed patch for the file, or `null` while the fetch is pending / gated / deferred. */
  section: FileDiffSection | null;
  /** Length of the fetched raw diff string when available. */
  rawLength: number | null;
  /**
   * True when the raw diff exceeds large-diff thresholds and parsing (or
   * fetching for large-by-lines files) is deferred until the user opts in.
   */
  isDeferredLarge: boolean;
  isLoading: boolean;
  errorMessage: string | null;
  /** Explicitly opt into fetching and parsing the current large diff revision. */
  displayLargeDiff: () => void;
}

export interface UseFileDiffSectionParams {
  featureId: number;
  filePath: string;
  /**
   * Pre-rename path for a rename/copy entry (from the changed-files list),
   * forwarded so the backend can scope the diff to both paths and detect the
   * rename instead of reporting a whole-file addition.
   */
  oldFilePath?: string;
  mode: DiffMode;
  targetBranch?: string;
  commitSha: string | null;
  /**
   * Gates only the *fetch* — driven by the row's expanded + virtualized-visible
   * state (and large-file opt-in) — so a collapsed / off-screen / deferred
   * large file costs nothing, while a file that HAS been fetched keeps its
   * parsed section after it scrolls out of view.
   */
  enabled: boolean;
  /**
   * Whether a diff exceeding `LARGE_DIFF_BYTES` (or `isLargeByLines`) should
   * be parsed synchronously. Defaults to `false` so huge diffs never block the
   * main thread with `parseUnifiedDiff` before the user clicks "Display diff".
   */
  allowLargeParse?: boolean;
  /** True when `additions + deletions >= LARGE_DIFF_LINES`. */
  isLargeByLines?: boolean;
}

/**
 * Fetch and parse the unified diff for a *single* file, lazily. This is the
 * per-file replacement for the old monolithic `/api/git/diff` fetch: the diff
 * pane calls it once per expanded, on-screen file, so the payload and the
 * synchronous parse are bounded to the files the user is actually looking at
 * instead of the whole working tree.
 *
 * When a fetched diff is large (`raw.length >= LARGE_DIFF_BYTES` or
 * `isLargeByLines`) and `allowLargeParse` is false, `parseUnifiedDiff` is
 * skipped entirely so multi-megabyte patches never stall the main thread until
 * the user explicitly opts in via "Display diff".
 */
export function useFileDiffSection({
  featureId,
  filePath,
  oldFilePath,
  mode,
  targetBranch,
  commitSha,
  enabled,
  allowLargeParse = false,
  isLargeByLines = false,
}: UseFileDiffSectionParams): FileDiffSectionResult {
  const scopeKey = `${featureId}:${mode}:${targetBranch ?? ""}:${commitSha ?? ""}:${filePath}:${oldFilePath ?? ""}`;
  const [optIn, setOptIn] = useState<LargeDiffOptInState>(NO_OPT_IN);
  const scopeOptedIn = optIn.kind !== "none" && optIn.scopeKey === scopeKey;
  const fetchEnabled = enabled && (!isLargeByLines || allowLargeParse || scopeOptedIn);

  const { data, isLoading, isError, error } = useGetFileDiff(
    {
      feature_id: featureId,
      file_path: filePath,
      old_file_path: oldFilePath,
      mode,
      target_branch: targetBranch,
      commit_sha: commitSha ?? undefined,
    },
    { query: { enabled: fetchEnabled, retry: retryUnlessRefusedForSize } },
  );

  const raw = data?.diff;
  const { optedIn, nextState } = reconcileOptInForRaw(optIn, scopeKey, raw);
  if (nextState !== null) setOptIn(nextState);

  const rawRef = useRef<string | undefined>(raw);
  rawRef.current = raw;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const displayLargeDiff = useCallback((): void => {
    const currentRaw = rawRef.current;
    const currentScopeKey = scopeKeyRef.current;
    setOptIn(
      currentRaw === undefined
        ? { kind: "pending", scopeKey: currentScopeKey }
        : { kind: "accepted", scopeKey: currentScopeKey, raw: currentRaw },
    );
  }, []);

  const effectiveAllowLargeParse = allowLargeParse || optedIn;
  const rawLength = raw === undefined ? null : raw.length;
  const isDeferredLarge = useMemo(() => {
    if (effectiveAllowLargeParse) return false;
    if (raw === undefined) return isLargeByLines;
    if (!isLargeByLines && raw.length < LARGE_DIFF_BYTES) return false;
    return !isBinaryPatch(raw);
  }, [effectiveAllowLargeParse, isLargeByLines, raw]);

  const section = useMemo<FileDiffSection | null>(() => {
    if (raw === undefined || isDeferredLarge) return null;
    // The backend emits exactly one `diff --git` block per file, so the first
    // parsed section is the whole patch. An empty-but-loaded diff yields
    // EMPTY_SECTION so the row shows "No text hunks", not a perpetual loader.
    return parseUnifiedDiff(raw)[0] ?? EMPTY_SECTION;
  }, [isDeferredLarge, raw]);

  // NB: don't gate `section` on `enabled` — once fetched, keep the parsed diff
  // mounted through scroll-out. `data`/`isLoading`/`isError` already reflect the
  // cache: an un-fetched, disabled row has `data === undefined` → `section` null.
  const errorMessage = isError
    ? apiErrorMessage(
        error,
        translateUi(
          "workspace.git.useFileDiffSection.failedToLoadThisFileSDiff",
          "Failed to load this file's diff",
        ),
      )
    : null;
  return useMemo(
    () => ({ section, rawLength, isDeferredLarge, isLoading, errorMessage, displayLargeDiff }),
    [displayLargeDiff, errorMessage, isDeferredLarge, isLoading, rawLength, section],
  );
}
