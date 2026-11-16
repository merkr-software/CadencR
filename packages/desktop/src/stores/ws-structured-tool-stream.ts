import type { AgentBlockData } from "@/types/agent-block";
import { clampText, type ClampedText } from "@/lib/block-content-budget";

interface JsonScanner {
  depth: number;
  inString: boolean;
  escaped: boolean;
  started: boolean;
}

export interface StructuredToolStream {
  chunks: string[];
  scanner: JsonScanner;
  preview: ClampedText;
  /** Last render-facing block reference produced from this exact raw prefix. */
  owner?: AgentBlockData;
}

export interface StructuredToolChunkResult {
  completed: string[];
  preview: ClampedText;
}

export function createStructuredToolStream(): StructuredToolStream {
  return {
    chunks: [],
    scanner: { depth: 0, inString: false, escaped: false, started: false },
    preview: { text: "", truncated: false },
  };
}

/** Scan only the new chunk and return complete top-level JSON values. */
export function pushStructuredToolChunk(
  stream: StructuredToolStream,
  chunk: string,
): StructuredToolChunkResult {
  const completed: string[] = [];
  let segmentStart = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    const character = chunk[index];
    const scanner = stream.scanner;
    if (!scanner.started) {
      if (character === " " || character === "\n" || character === "\r" || character === "\t") {
        continue;
      }
      if (character !== "{" && character !== "[") continue;
      scanner.started = true;
      scanner.depth = 1;
      continue;
    }
    if (scanner.inString) {
      if (scanner.escaped) scanner.escaped = false;
      else if (character === "\\") scanner.escaped = true;
      else if (character === '"') scanner.inString = false;
      continue;
    }
    if (character === '"') scanner.inString = true;
    else if (character === "{" || character === "[") scanner.depth += 1;
    else if (character === "}" || character === "]") scanner.depth -= 1;
    if (scanner.depth !== 0) continue;

    stream.chunks.push(chunk.slice(segmentStart, index + 1));
    completed.push(stream.chunks.join(""));
    stream.chunks = [];
    stream.scanner = { depth: 0, inString: false, escaped: false, started: false };
    segmentStart = index + 1;
  }
  if (segmentStart < chunk.length) stream.chunks.push(chunk.slice(segmentStart));
  stream.preview = appendPreview(stream.preview, chunk);
  return { completed, preview: stream.preview };
}

export function pendingStructuredToolContent(stream: StructuredToolStream): string {
  return stream.chunks.join("");
}

function appendPreview(previous: ClampedText, chunk: string): ClampedText {
  // Once the preview says it is truncated, keep it stable until a complete
  // snapshot replaces it. Re-clamping the 128 KiB preview for every tiny delta
  // is bounded in memory but still quadratic in work.
  if (previous.truncated) return previous;
  return clampText(previous.text + chunk);
}
