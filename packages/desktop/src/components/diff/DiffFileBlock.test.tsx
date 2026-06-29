import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import { DiffFileBlock } from "./DiffFileBlock";

const mocks = vi.hoisted(() => ({
  patchDiffViewMock: vi.fn(
    ({
      patch,
      collapsed,
      renderHeaderPrefix,
      renderHeaderMetadata,
    }: {
      patch: string;
      collapsed?: boolean;
      renderHeaderPrefix?: () => ReactNode;
      renderHeaderMetadata?: () => ReactNode;
    }) => (
      <div
        data-testid="patch-diff-view"
        data-patch={patch}
        data-collapsed={String(Boolean(collapsed))}
      >
        {renderHeaderPrefix?.()}
        {renderHeaderMetadata?.()}
      </div>
    ),
  ),
}));

vi.mock("./PatchDiffView", () => ({
  PatchDiffView: (props: Parameters<typeof mocks.patchDiffViewMock>[0]) =>
    mocks.patchDiffViewMock(props),
}));

const patch = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;

const baseProps = {
  section: { oldFileName: "src/foo.ts", newFileName: "src/foo.ts", hunks: [patch] },
  diffMode: "unified" as const,
  displayName: "src/foo.ts",
  additions: 1,
  deletions: 1,
  themeAppearance: "dark" as const,
  themeId: "dracula" as const,
  isFocused: false,
  isFileViewed: false,
  showViewedCheckbox: true,
  onToggleFile: vi.fn(),
  onMarkViewedFile: vi.fn(),
  onUnmarkViewedFile: vi.fn(),
};

beforeEach(() => {
  mocks.patchDiffViewMock.mockClear();
});

describe("DiffFileBlock", () => {
  it("renders a cheap header instead of hydrating Pierre for collapsed files", () => {
    const { getByText, queryByTestId } = render(<DiffFileBlock {...baseProps} isCollapsed />);
    expect(getByText("src/foo.ts")).toBeInTheDocument();
    expect(queryByTestId("patch-diff-view")).not.toBeInTheDocument();
  });

  it("shows the file-change status icon in the collapsed header", () => {
    const { container } = render(<DiffFileBlock {...baseProps} isCollapsed />);
    // src/foo.ts → src/foo.ts (no /dev/null) resolves to a "modified" glyph.
    expect(container.querySelector('use[href="#diffs-icon-symbol-modified"]')).toBeInTheDocument();
  });

  it("renders the authoritative patch hunk instead of fetching full file contents", () => {
    const { getByTestId } = render(<DiffFileBlock {...baseProps} isCollapsed={false} />);
    expect(getByTestId("patch-diff-view")).toHaveAttribute("data-patch", patch);
  });

  it("opens the file at the first changed line from the expanded header", async () => {
    const onOpenFileInEditor = vi.fn();
    const { user } = render(
      <DiffFileBlock {...baseProps} isCollapsed={false} onOpenFileInEditor={onOpenFileInEditor} />,
    );

    await user.click(screen.getByRole("button", { name: "Open src/foo.ts in editor" }));

    expect(onOpenFileInEditor).toHaveBeenCalledWith("src/foo.ts", 1);
  });

  it("opens the file at the first changed line from the collapsed header", async () => {
    const onOpenFileInEditor = vi.fn();
    const { user } = render(
      <DiffFileBlock {...baseProps} isCollapsed onOpenFileInEditor={onOpenFileInEditor} />,
    );

    await user.click(screen.getByRole("button", { name: "Open src/foo.ts in editor" }));

    expect(onOpenFileInEditor).toHaveBeenCalledWith("src/foo.ts", 1);
  });

  it("renders a binary placeholder for binary/no-hunk patches", () => {
    const binaryPatch = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`;
    const { getByText, getByTestId } = render(
      <DiffFileBlock
        {...baseProps}
        section={{
          oldFileName: "image.png",
          newFileName: "image.png",
          hunks: [binaryPatch],
        }}
        isCollapsed={false}
      />,
    );
    expect(getByText("Binary file")).toBeInTheDocument();
    expect(getByTestId("patch-diff-view")).toHaveAttribute("data-patch", binaryPatch);
  });

  it("memoizes structurally-equal sections so unchanged files don't re-render", () => {
    const { rerender } = render(<DiffFileBlock {...baseProps} isCollapsed={false} />);
    const initialCalls = mocks.patchDiffViewMock.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    rerender(
      <DiffFileBlock
        {...baseProps}
        section={{
          oldFileName: "src/foo.ts",
          newFileName: "src/foo.ts",
          hunks: [patch],
        }}
        isCollapsed={false}
      />,
    );
    expect(mocks.patchDiffViewMock.mock.calls.length).toBe(initialCalls);

    rerender(
      <DiffFileBlock
        {...baseProps}
        section={{
          oldFileName: "src/foo.ts",
          newFileName: "src/foo.ts",
          hunks: [patch.replace("+new", "+changed")],
        }}
        isCollapsed={false}
      />,
    );
    expect(mocks.patchDiffViewMock.mock.calls.length).toBeGreaterThan(initialCalls);
  });
});
