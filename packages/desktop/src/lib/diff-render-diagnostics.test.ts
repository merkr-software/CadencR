import { describe, expect, it } from "vitest";
import {
  countTextLines,
  getDiffRenderDiagnostics,
  recordHeavyInlineMounted,
  recordHeavyInlineUnmounted,
  recordHeavyInlineUpdated,
  recordHeavyInlineVisible,
  recordPierreCleaned,
  recordPierreCreated,
  recordPierreRenderCompleted,
  recordPierreRenderStarted,
} from "./diff-render-diagnostics";

describe("diff-render-diagnostics", () => {
  it("tracks completed and cancelled render lifecycles without retaining instances", () => {
    const before = getDiffRenderDiagnostics();
    const instanceId = "diagnostics-test-instance";

    recordPierreCreated(instanceId, 12, 3);
    recordPierreRenderStarted(instanceId);
    recordPierreRenderStarted(instanceId);
    recordPierreRenderCompleted(instanceId);
    recordPierreCleaned(instanceId, 4);

    const after = getDiffRenderDiagnostics();
    expect(after.pierreCreated - before.pierreCreated).toBe(1);
    expect(after.pierreCleaned - before.pierreCleaned).toBe(1);
    expect(after.pierreLive).toBe(before.pierreLive);
    expect(after.highlightStarted - before.highlightStarted).toBe(2);
    expect(after.highlightCompleted - before.highlightCompleted).toBe(1);
    expect(after.highlightCancelled - before.highlightCancelled).toBe(1);
    expect(window.__CADENCR_DIFF_DIAGNOSTICS__).toEqual(after);
  });

  it("counts empty and newline-terminated text correctly", () => {
    expect(countTextLines("")).toBe(0);
    expect(countTextLines("one\ntwo\n")).toBe(3);
  });

  it("updates heavy-inline maxima without changing mount or visibility counts", () => {
    const before = getDiffRenderDiagnostics();
    const blockId = "diagnostics-heavy-inline-update";
    const patchChars = before.maxPatchChars + 1;
    const patchLines = before.maxPatchLines + 1;

    recordHeavyInlineMounted(blockId);
    recordHeavyInlineVisible(blockId, true);
    recordHeavyInlineUpdated(blockId, patchChars, patchLines);
    recordHeavyInlineUpdated(blockId, patchChars + 1, patchLines + 1);

    const updated = getDiffRenderDiagnostics();
    expect(updated.heavyInlineMounts - before.heavyInlineMounts).toBe(1);
    expect(updated.heavyInlineMounted - before.heavyInlineMounted).toBe(1);
    expect(updated.heavyInlineVisible - before.heavyInlineVisible).toBe(1);
    expect(updated.maxPatchChars).toBe(patchChars + 1);
    expect(updated.maxPatchLines).toBe(patchLines + 1);

    recordHeavyInlineUnmounted(blockId);
    const unmounted = getDiffRenderDiagnostics();
    expect(unmounted.heavyInlineMounted).toBe(before.heavyInlineMounted);
    expect(unmounted.heavyInlineVisible).toBe(before.heavyInlineVisible);
  });
});
