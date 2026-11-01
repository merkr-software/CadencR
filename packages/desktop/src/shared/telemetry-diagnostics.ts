import type { z } from "zod";
import type { rendererErrorSchema } from "./renderer-diagnostics";
import type { DiagnosticFrame, DiagnosticReport } from "../api/generated";

export type RemoteDiagnosticFrame = DiagnosticFrame;
export interface RemoteDiagnostic extends DiagnosticReport {
  frames: RemoteDiagnosticFrame[];
}

const categories = {
  error: "renderer_unhandled_error",
  unhandledrejection: "renderer_unhandled_rejection",
  "react-boundary": "react_boundary",
  "react-uncaught": "react_boundary",
  "react-recoverable": "renderer_recoverable",
} as const;

/** Only exact filenames present in this build survive; no messages, paths or function names. */
export function remoteDiagnosticFrames(
  stack: string | null | undefined,
  assets: ReadonlySet<string>,
): RemoteDiagnosticFrame[] {
  const frames: RemoteDiagnosticFrame[] = [];
  for (const line of (stack ?? "").slice(0, 12_000).split("\n").slice(1, 31)) {
    const match = /(?:[/\\])([A-Za-z0-9_-]+\.js):(\d+):(\d+)\)?$/.exec(line.trim());
    if (!match || !assets.has(match[1])) continue;
    const lineno = Number(match[2]);
    const colno = Number(match[3]);
    if (!Number.isSafeInteger(lineno) || !Number.isSafeInteger(colno) || lineno < 1 || colno < 1)
      continue;
    frames.push({ filename: `assets/${match[1]}`, lineno, colno });
  }
  return frames.reverse();
}

export function rendererRemoteDiagnostic(
  error: z.infer<typeof rendererErrorSchema>,
  assets: ReadonlySet<string>,
): RemoteDiagnostic {
  const buildId = error.diagnostics?.buildId;
  return {
    ...(buildId && /^[A-Za-z0-9._-]{1,128}$/.test(buildId) ? { build_id: buildId } : {}),
    category: categories[error.source],
    frames: remoteDiagnosticFrames(error.stack, assets),
  };
}

export function mainRemoteDiagnostic(error: unknown): RemoteDiagnostic {
  const frames: RemoteDiagnosticFrame[] = [];
  for (const line of (error instanceof Error ? (error.stack ?? "") : "")
    .slice(0, 12000)
    .split("\n")
    .slice(1, 31)) {
    const match = /[/\\]main[/\\]index\.js:(\d+):(\d+)\)?$/.exec(line.trim());
    if (!match) continue;
    const lineno = Number(match[1]);
    const colno = Number(match[2]);
    if (Number.isSafeInteger(lineno) && Number.isSafeInteger(colno) && lineno > 0 && colno > 0)
      frames.push({ filename: "main/index.js", lineno, colno });
  }
  return { category: "electron_main", frames: frames.reverse() };
}
