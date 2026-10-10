import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { renderFileChangeBlocks } from "./file-change-block";

const mocks = vi.hoisted(() => ({
  patchDiffViewMock: vi.fn(({ patch }: { patch: string }) => (
    <div data-testid="diff-view" data-patch={patch}>
      diff content
    </div>
  )),
}));

vi.mock("@/components/diff/PatchDiffView", () => ({
  PatchDiffView: (props: Parameters<typeof mocks.patchDiffViewMock>[0]) =>
    mocks.patchDiffViewMock(props),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ theme: { id: "dracula", appearance: "dark" } }),
}));

function multiFilePatchArgs(): string {
  return JSON.stringify({
    patchText:
      "*** Begin Patch\n" +
      "*** Update File: src/a.ts\n" +
      "@@\n" +
      "-a\n" +
      "+aa\n" +
      "*** Update File: src/b.ts\n" +
      "@@\n" +
      "-b\n" +
      "+bb\n" +
      "*** End Patch",
  });
}

function ControlledFileChangeHarness(): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  return renderFileChangeBlocks(
    "ApplyPatch",
    multiFilePatchArgs(),
    undefined,
    expanded,
    setExpanded,
  );
}

describe("renderFileChangeBlocks", () => {
  // `CollapsibleSection` keeps a collapsing body mounted for its 200ms close
  // animation once the expand rAFs have fired, so "collapsed" assertions only
  // held when the runner was fast enough to click again before those frames.
  // The kill-switch makes mount/unmount synchronous; animation timing has its
  // own coverage in `collapsible-section.test.tsx`.
  beforeEach(() => {
    document.documentElement.dataset.animations = "off";
  });
  afterEach(() => {
    delete document.documentElement.dataset.animations;
  });

  it("expands only the clicked inline diff in a multi-file patch", async () => {
    const { user } = render(<ControlledFileChangeHarness />);

    expect(screen.queryAllByTestId("diff-view")).toHaveLength(0);

    const headers = screen.getAllByTestId("inline-diff-header");
    await user.click(headers[0]);

    const openDiffs = screen.getAllByTestId("diff-view");
    expect(openDiffs).toHaveLength(1);
    expect(openDiffs[0]).toHaveAttribute("data-patch", expect.stringContaining("src/a.ts"));

    await user.click(headers[0]);
    expect(screen.queryAllByTestId("diff-view")).toHaveLength(0);

    await user.click(headers[1]);
    const secondOpenDiffs = screen.getAllByTestId("diff-view");
    expect(secondOpenDiffs).toHaveLength(1);
    expect(secondOpenDiffs[0]).toHaveAttribute("data-patch", expect.stringContaining("src/b.ts"));

    await user.click(headers[0]);
    const bothOpenDiffs = screen.getAllByTestId("diff-view");
    expect(bothOpenDiffs).toHaveLength(2);
    expect(bothOpenDiffs[0]).toHaveAttribute("data-patch", expect.stringContaining("src/a.ts"));
    expect(bothOpenDiffs[1]).toHaveAttribute("data-patch", expect.stringContaining("src/b.ts"));
  });
});
