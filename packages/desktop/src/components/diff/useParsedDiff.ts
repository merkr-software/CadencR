import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { buildParsedFileMeta, type ParsedFileMeta } from "@/lib/parse-unified-diff";
import DiffParseWorker from "./diff-parse.worker?worker";
import type { DiffParseRequest, DiffParseResponse } from "./diff-parse.worker";

// Below this raw-diff size the synchronous parse is imperceptible, so we skip
// the worker round-trip (and the loader flash it would cause) entirely. Tuned
// to comfortably clear typical edits while still offloading genuinely large
// diffs — the case the user feels when opening a long conversation.
const WORKER_PARSE_THRESHOLD_BYTES = 64 * 1024;

const EMPTY_FILE_META: ParsedFileMeta[] = [];

export interface ParsedDiff {
  fileMeta: ParsedFileMeta[];
  fileNames: string[];
  /** True while a large diff is being parsed off the main thread. */
  isParsing: boolean;
}

/**
 * Parse a unified diff into per-file metadata, off the main thread for large
 * diffs. Small diffs parse synchronously (instant, no worker). The worker is
 * reused across diff changes and torn down on unmount; a monotonic request id
 * drops responses for a superseded diff so a slow parse of an old diff can't
 * clobber the current one. On worker failure we parse inline and surface a
 * toast rather than leaving the diff stranded.
 */
export function useParsedDiff(rawDiff: string | undefined): ParsedDiff {
  const diff = rawDiff ?? "";
  const useWorker = diff.length > WORKER_PARSE_THRESHOLD_BYTES;

  // Small (and empty) diffs: parse inline — no worker, no loading state.
  const syncFileMeta = useMemo(
    () => (useWorker ? null : buildParsedFileMeta(diff)),
    [useWorker, diff],
  );

  const [asyncFileMeta, setAsyncFileMeta] = useState<ParsedFileMeta[] | null>(null);
  const [isParsing, setIsParsing] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  useEffect((): (() => void) | void => {
    if (!useWorker) {
      // Left worker territory (small/empty diff): drop any stale async result.
      setAsyncFileMeta(null);
      setIsParsing(false);
      return undefined;
    }

    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setIsParsing(true);

    let worker = workerRef.current;
    if (!worker) {
      worker = new DiffParseWorker();
      workerRef.current = worker;
    }

    const onMessage = (event: MessageEvent<DiffParseResponse>): void => {
      if (event.data.requestId !== requestId) return; // superseded
      setAsyncFileMeta(event.data.fileMeta);
      setIsParsing(false);
    };
    const onError = (): void => {
      if (requestId !== requestIdRef.current) return;
      setAsyncFileMeta(buildParsedFileMeta(diff));
      setIsParsing(false);
      toast.error("Diff parsing fell back to the main thread");
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    const request: DiffParseRequest = { requestId, rawDiff: diff };
    worker.postMessage(request);

    return () => {
      worker?.removeEventListener("message", onMessage);
      worker?.removeEventListener("error", onError);
    };
  }, [useWorker, diff]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  const fileMeta = useWorker
    ? (asyncFileMeta ?? EMPTY_FILE_META)
    : (syncFileMeta ?? EMPTY_FILE_META);
  const fileNames = useMemo(() => fileMeta.map((meta) => meta.displayName), [fileMeta]);

  // While a worker parse is pending (including the first render before the
  // effect runs, when `asyncFileMeta` is still null) report parsing so callers
  // show a loader instead of an empty diff.
  return { fileMeta, fileNames, isParsing: useWorker && (isParsing || asyncFileMeta === null) };
}
