export interface DiffRenderDiagnosticsSnapshot {
  pierreCreated: number;
  pierreCleaned: number;
  pierreLive: number;
  highlightStarted: number;
  highlightCompleted: number;
  highlightCancelled: number;
  maxPatchChars: number;
  maxPatchLines: number;
  maxCleanupDurationMs: number;
  heavyInlineMounted: number;
  heavyInlineVisible: number;
  heavyInlineMounts: number;
}

const livePierre = new Set<string>();
const pendingPierre = new Map<string, number>();
const mountedHeavyInline = new Set<string>();
const visibleHeavyInline = new Set<string>();

let pierreCreated = 0;
let pierreCleaned = 0;
let highlightStarted = 0;
let highlightCompleted = 0;
let highlightCancelled = 0;
let maxPatchChars = 0;
let maxPatchLines = 0;
let maxCleanupDurationMs = 0;
let heavyInlineMounts = 0;

export function getDiffRenderDiagnostics(): DiffRenderDiagnosticsSnapshot {
  return {
    pierreCreated,
    pierreCleaned,
    pierreLive: livePierre.size,
    highlightStarted,
    highlightCompleted,
    highlightCancelled,
    maxPatchChars,
    maxPatchLines,
    maxCleanupDurationMs,
    heavyInlineMounted: mountedHeavyInline.size,
    heavyInlineVisible: visibleHeavyInline.size,
    heavyInlineMounts,
  };
}

export function countTextLines(text: string): number {
  let lines = text.length === 0 ? 0 : 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export function recordPierreCreated(
  instanceId: string,
  patchChars: number,
  patchLines: number,
): void {
  if (!livePierre.has(instanceId)) {
    livePierre.add(instanceId);
    pierreCreated += 1;
  }
  maxPatchChars = Math.max(maxPatchChars, patchChars);
  maxPatchLines = Math.max(maxPatchLines, patchLines);
}

export function recordPierreRenderStarted(instanceId: string): void {
  pendingPierre.set(instanceId, (pendingPierre.get(instanceId) ?? 0) + 1);
  highlightStarted += 1;
}

export function recordPierreRenderCompleted(instanceId: string): void {
  const pending = pendingPierre.get(instanceId);
  if (pending == null) return;
  if (pending === 1) pendingPierre.delete(instanceId);
  else pendingPierre.set(instanceId, pending - 1);
  highlightCompleted += 1;
}

export function recordPierreCleaned(instanceId: string, cleanupMs: number): void {
  if (livePierre.delete(instanceId)) pierreCleaned += 1;
  maxCleanupDurationMs = Math.max(maxCleanupDurationMs, cleanupMs);
  const pending = pendingPierre.get(instanceId);
  if (pending != null) {
    pendingPierre.delete(instanceId);
    highlightCancelled += pending;
  }
}

export function recordHeavyInlineMounted(blockId: string): void {
  mountedHeavyInline.add(blockId);
  heavyInlineMounts += 1;
}

/** Update maxima without changing the block's mount or visibility lifecycle. */
export function recordHeavyInlineUpdated(
  blockId: string,
  patchChars: number,
  patchLines: number,
): void {
  if (!mountedHeavyInline.has(blockId)) return;
  maxPatchChars = Math.max(maxPatchChars, patchChars);
  maxPatchLines = Math.max(maxPatchLines, patchLines);
}

export function recordHeavyInlineVisible(blockId: string, visible: boolean): void {
  if (visible) visibleHeavyInline.add(blockId);
  else visibleHeavyInline.delete(blockId);
}

export function recordHeavyInlineUnmounted(blockId: string): void {
  mountedHeavyInline.delete(blockId);
  visibleHeavyInline.delete(blockId);
}

declare global {
  interface Window {
    __CADENCR_DIFF_DIAGNOSTICS__?: DiffRenderDiagnosticsSnapshot;
  }
}

// Intentionally available in packaged builds for reporter diagnostics. A
// getter keeps the render hot path allocation-free until somebody inspects it.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__CADENCR_DIFF_DIAGNOSTICS__", {
    configurable: true,
    get: getDiffRenderDiagnostics,
  });
}
