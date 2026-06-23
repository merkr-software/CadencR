/**
 * Off-main-thread diff parser. Parsing + line-stat'ing a large unified diff
 * walks the entire (multi-MB) string synchronously; doing it on the main thread
 * janks the Git tab on open. This worker runs that work off-thread and posts
 * back the finished per-file metadata. Only used above a size threshold —
 * `useParsedDiff` parses small diffs inline to avoid the worker round-trip.
 *
 * Relative import (not the `@/` alias) keeps the worker bundle self-contained
 * regardless of how the worker build resolves aliases.
 */
import { buildParsedFileMeta, type ParsedFileMeta } from "../../lib/parse-unified-diff";

export interface DiffParseRequest {
  /** Monotonic token so the hook can drop responses for a superseded diff. */
  requestId: number;
  rawDiff: string;
}

export interface DiffParseResponse {
  requestId: number;
  fileMeta: ParsedFileMeta[];
}

self.onmessage = (event: MessageEvent<DiffParseRequest>): void => {
  const { requestId, rawDiff } = event.data;
  const response: DiffParseResponse = {
    requestId,
    fileMeta: buildParsedFileMeta(rawDiff),
  };
  self.postMessage(response);
};
