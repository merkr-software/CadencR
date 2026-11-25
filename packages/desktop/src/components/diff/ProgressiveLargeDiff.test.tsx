import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { ProgressiveLargeDiff } from "./ProgressiveLargeDiff";

const mocks = vi.hoisted(() => ({
  patchDiffViewMock: vi.fn(({ patch }: { patch: string }) => (
    <div data-testid="patch-diff-view" data-patch-length={patch.length} />
  )),
}));

vi.mock("./PatchDiffView", () => ({
  PatchDiffView: (props: Parameters<typeof mocks.patchDiffViewMock>[0]) =>
    mocks.patchDiffViewMock(props),
}));

function makeBigPatch(changedLines: number): string {
  const body = Array.from({ length: changedLines }, (_, i) => `+line ${i}`).join("\n");
  return `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,${changedLines} @@\n${body}\n`;
}

const baseProps = {
  mode: "unified" as const,
  themeAppearance: "dark" as const,
  themeId: "dracula" as const,
};

/**
 * Fire pending chunk timers until the progressive render settles. Each mount
 * schedules the next tick from an effect, so a single runAllTimers() inside
 * one act() can't drain the chain — effects flush when the act scope closes.
 */
function drainChunkTimers(): void {
  for (let i = 0; i < 50 && vi.getTimerCount() > 0; i++) {
    act(() => vi.runOnlyPendingTimers());
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.patchDiffViewMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProgressiveLargeDiff", () => {
  it("mounts one bounded chunk per tick instead of rendering the patch in one task", () => {
    render(<ProgressiveLargeDiff {...baseProps} patch={makeBigPatch(2000)} />);

    // First chunk only, with a visible progress indicator (2000 lines → 5 chunks).
    expect(screen.getAllByTestId("patch-diff-view")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Rendering diff… 20%");

    // Each timer tick mounts exactly one more chunk.
    act(() => vi.advanceTimersToNextTimer());
    expect(screen.getAllByTestId("patch-diff-view")).toHaveLength(2);

    // Draining all timers mounts everything and clears the progress state.
    drainChunkTimers();
    expect(screen.getAllByTestId("patch-diff-view")).toHaveLength(5);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders a small patch as a single chunk with no progress state", () => {
    render(<ProgressiveLargeDiff {...baseProps} patch={makeBigPatch(100)} />);

    expect(screen.getAllByTestId("patch-diff-view")).toHaveLength(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("restarts from the first chunk when the patch changes", () => {
    const { rerender } = render(<ProgressiveLargeDiff {...baseProps} patch={makeBigPatch(2000)} />);
    drainChunkTimers();
    expect(screen.getAllByTestId("patch-diff-view")).toHaveLength(5);

    // Swapping to a new patch while the old one was fully drained must NOT
    // commit the old visibleCount (5) worth of the new chunks in one frame —
    // that would re-freeze. The reset happens during render, so only the
    // first chunk of the NEW patch is shown.
    rerender(<ProgressiveLargeDiff {...baseProps} patch={makeBigPatch(1200)} />);
    const shown = screen.getAllByTestId("patch-diff-view");
    expect(shown).toHaveLength(1);
    // Each chunk is a bounded ≤400-line sub-patch, never the whole 1200-line one.
    expect(Number(shown[0].getAttribute("data-patch-length"))).toBeLessThan(
      makeBigPatch(1200).length,
    );
    drainChunkTimers();
    expect(screen.getAllByTestId("patch-diff-view")).toHaveLength(3);
  });
});
