import { useState, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import { DiffFileBlock } from "./DiffFileBlock";
import type { FileDiffSection } from "@/lib/parse-unified-diff";
import { FileStageState } from "@/api/generated";

const patch = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;

const defaultSection: FileDiffSection = {
  oldFileName: "src/foo.ts",
  newFileName: "src/foo.ts",
  hunks: [patch],
};

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
  // The per-file diff is fetched lazily; tests drive the returned section
  // through this mutable holder instead of passing it as a prop.
  section: null as FileDiffSection | null,
  rawLength: null as number | null,
  isDeferredLarge: false,
  isLoading: false,
  errorMessage: null as string | null,
  useFileDiffSectionSpy: vi.fn(),
}));

vi.mock("./DiffImageView", () => ({
  DiffImageView: ({ filePath, status }: { filePath: string; status: string }) => (
    <div data-testid="diff-image-view" data-file-path={filePath} data-status={status} />
  ),
}));

vi.mock("./PatchDiffView", () => ({
  PatchDiffView: (props: Parameters<typeof mocks.patchDiffViewMock>[0]) =>
    mocks.patchDiffViewMock(props),
}));

vi.mock("./useFileDiffSection", () => ({
  useFileDiffSection: (params: {
    enabled: boolean;
    allowLargeParse?: boolean;
    isLargeByLines?: boolean;
  }) => {
    mocks.useFileDiffSectionSpy(params);
    const [optedIn, setOptedIn] = useState(false);
    const effectiveAllow = Boolean(params.allowLargeParse) || optedIn;
    const deferredByLines = Boolean(params.isLargeByLines) && !effectiveAllow;
    const deferredByBytes = mocks.isDeferredLarge && !effectiveAllow;
    const fetchEnabled = params.enabled && !deferredByLines;
    return {
      // Models the real hook: a row that hasn't been fetched (collapsed / off
      // screen / deferred large) has no section yet.
      section: fetchEnabled && !deferredByBytes ? mocks.section : null,
      rawLength: fetchEnabled ? mocks.rawLength : null,
      isDeferredLarge: params.enabled && (deferredByLines || deferredByBytes),
      isLoading: fetchEnabled && mocks.isLoading,
      errorMessage: fetchEnabled ? mocks.errorMessage : null,
      displayLargeDiff: () => setOptedIn(true),
    };
  },
}));

vi.mock("./GitConflictFileBanner", () => ({
  GitConflictFileBanner: ({ file }: { file: { stage_state?: string } }) =>
    file.stage_state === "conflicted" ? <div data-testid="conflict-banner">Conflict</div> : null,
}));

const baseProps = {
  featureId: 1,
  mode: "uncommitted" as const,
  file: {
    file: "src/foo.ts",
    status: "M",
    additions: 1,
    deletions: 1,
    stage_state: FileStageState.unstaged,
  },
  isVisible: true,
  diffMode: "unified" as const,
  themeAppearance: "dark" as const,
  themeId: "dracula" as const,
  isFocused: false,
  isFileViewed: false,
  isViewedPending: false,
  showViewedCheckbox: true,
  onToggleFile: vi.fn(),
  onMarkViewedFile: vi.fn(),
  onUnmarkViewedFile: vi.fn(),
};

beforeEach(() => {
  mocks.patchDiffViewMock.mockClear();
  mocks.useFileDiffSectionSpy.mockClear();
  mocks.section = defaultSection;
  mocks.rawLength = null;
  mocks.isDeferredLarge = false;
  mocks.isLoading = false;
  mocks.errorMessage = null;
});

describe("DiffFileBlock", () => {
  it("renders a cheap header instead of hydrating Pierre for collapsed files", () => {
    const { getByText, queryByTestId } = render(<DiffFileBlock {...baseProps} isCollapsed />);
    expect(getByText("src/foo.ts")).toBeInTheDocument();
    expect(queryByTestId("patch-diff-view")).not.toBeInTheDocument();
  });

  it("shows the file-change status icon in the collapsed header from the status code", () => {
    const { container } = render(<DiffFileBlock {...baseProps} isCollapsed />);
    // status "M" resolves to a "modified" glyph without fetching the patch.
    expect(container.querySelector('use[href="#diffs-icon-symbol-modified"]')).toBeInTheDocument();
  });

  it("renders the lazily-fetched patch hunk once expanded", () => {
    const { getByTestId } = render(<DiffFileBlock {...baseProps} isCollapsed={false} />);
    expect(getByTestId("patch-diff-view")).toHaveAttribute("data-patch", patch);
  });

  it("shows a loader while the per-file diff is still fetching", () => {
    mocks.section = null;
    mocks.isLoading = true;
    const { getByText, queryByTestId } = render(
      <DiffFileBlock {...baseProps} isCollapsed={false} />,
    );
    expect(getByText("Loading diff…")).toBeInTheDocument();
    expect(queryByTestId("patch-diff-view")).not.toBeInTheDocument();
  });

  it("retains the actual per-file diff query error", () => {
    mocks.section = null;
    mocks.errorMessage = "Failed to load this file's diff: porcelain failed";
    render(<DiffFileBlock {...baseProps} isCollapsed={false} />);

    expect(screen.getByText(/porcelain failed/)).toBeInTheDocument();
  });

  it("opens the file at the first changed line from the expanded header", async () => {
    const onOpenFileInEditor = vi.fn();
    const { user } = render(
      <DiffFileBlock {...baseProps} isCollapsed={false} onOpenFileInEditor={onOpenFileInEditor} />,
    );

    await user.click(screen.getByRole("button", { name: "Open src/foo.ts in editor" }));

    expect(onOpenFileInEditor).toHaveBeenCalledWith("src/foo.ts", 1);
  });

  it("opens a collapsed file at the top — its patch isn't fetched, so no line", async () => {
    // A collapsed row never fetches its diff, so there's no patch to derive a
    // first-changed line from; it opens at the top (undefined line) rather than
    // paying for a whole-file fetch just to compute a jump target.
    const onOpenFileInEditor = vi.fn();
    const { user } = render(
      <DiffFileBlock {...baseProps} isCollapsed onOpenFileInEditor={onOpenFileInEditor} />,
    );

    await user.click(screen.getByRole("button", { name: "Open src/foo.ts in editor" }));

    expect(onOpenFileInEditor).toHaveBeenCalledWith("src/foo.ts", undefined);
  });

  it("shows a file name holding a newline escaped, and still acts on the real path", async () => {
    const onOpenFileInEditor = vi.fn();
    const indexActions = {
      stage: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      pendingAction: null,
      pendingPath: null,
      error: null,
    };
    const { user } = render(
      <DiffFileBlock
        {...baseProps}
        file={{ ...baseProps.file, file: "a\nb.txt" }}
        isCollapsed
        onOpenFileInEditor={onOpenFileInEditor}
        indexActions={indexActions}
      />,
    );

    expect(screen.getByText('"a\\nb.txt"')).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: 'Open "a\\nb.txt" in editor' }));
    expect(onOpenFileInEditor).toHaveBeenCalledWith("a\nb.txt", undefined);
    await user.click(screen.getByRole("button", { name: 'Stage "a\\nb.txt"' }));
    expect(indexActions.stage).toHaveBeenCalledWith("a\nb.txt");
  });

  it("surfaces the conflict banner for an unmerged file", () => {
    render(
      <DiffFileBlock
        {...baseProps}
        file={{
          ...baseProps.file,
          status: "UU",
          stage_state: FileStageState.conflicted,
          conflict_kind: "uu",
        }}
        isCollapsed={false}
        onOpenFileInEditor={vi.fn()}
      />,
    );

    // The banner owns staging; opening the file resolves it automatically, so
    // there is no in-diff "Resolve in Editor" handoff to click.
    expect(screen.getByTestId("conflict-banner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve in Editor" })).not.toBeInTheDocument();
  });

  it("exposes the Viewed checkbox by name and toggles it through its visible label", async () => {
    const onMarkViewedFile = vi.fn();
    const onUnmarkViewedFile = vi.fn();
    const { rerender, user } = render(
      <DiffFileBlock
        {...baseProps}
        isCollapsed
        onMarkViewedFile={onMarkViewedFile}
        onUnmarkViewedFile={onUnmarkViewedFile}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Viewed" })).not.toBeChecked();
    await user.click(screen.getByText("Viewed"));
    expect(onMarkViewedFile).toHaveBeenCalledWith("src/foo.ts");
    expect(onUnmarkViewedFile).not.toHaveBeenCalled();

    rerender(
      <DiffFileBlock
        {...baseProps}
        isCollapsed
        isFileViewed
        onMarkViewedFile={onMarkViewedFile}
        onUnmarkViewedFile={onUnmarkViewedFile}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Viewed" })).toBeChecked();
    await user.click(screen.getByText("Viewed"));
    expect(onUnmarkViewedFile).toHaveBeenCalledWith("src/foo.ts");
  });

  it("toggles the Viewed checkbox with Space", async () => {
    const onMarkViewedFile = vi.fn();
    const { user } = render(
      <DiffFileBlock {...baseProps} isCollapsed onMarkViewedFile={onMarkViewedFile} />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Viewed" });

    checkbox.focus();
    await user.keyboard(" ");

    expect(onMarkViewedFile).toHaveBeenCalledWith("src/foo.ts");
  });

  it("announces and disables the Viewed checkbox while its mutation is pending", async () => {
    const onMarkViewedFile = vi.fn();
    const onUnmarkViewedFile = vi.fn();
    const { user } = render(
      <DiffFileBlock
        {...baseProps}
        isCollapsed
        isViewedPending
        onMarkViewedFile={onMarkViewedFile}
        onUnmarkViewedFile={onUnmarkViewedFile}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Viewed" });

    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveAttribute("aria-busy", "true");
    expect(checkbox).toHaveAccessibleDescription("Updating viewed state");

    await user.click(screen.getByText("Viewed"));
    checkbox.focus();
    await user.keyboard(" ");

    expect(onMarkViewedFile).not.toHaveBeenCalled();
    expect(onUnmarkViewedFile).not.toHaveBeenCalled();
  });

  it("uses unique valid label associations for repeated diff headers", async () => {
    const onMarkViewedFile = vi.fn();
    const { user } = render(
      <>
        <DiffFileBlock {...baseProps} isCollapsed onMarkViewedFile={onMarkViewedFile} />
        <DiffFileBlock
          {...baseProps}
          file={{ ...baseProps.file, file: "src/bar.ts" }}
          isCollapsed
          onMarkViewedFile={onMarkViewedFile}
        />
      </>,
    );
    const checkboxes = screen.getAllByRole("checkbox", { name: "Viewed" });
    const labels = screen.getAllByText("Viewed");
    const checkboxIds = checkboxes.map((checkbox) => checkbox.id);

    expect(checkboxes).toHaveLength(2);
    expect(new Set(checkboxIds)).toHaveProperty("size", 2);
    for (const [index, label] of labels.entries()) {
      expect(label).toHaveAttribute("for", checkboxIds[index]);
      expect(document.getElementById(checkboxIds[index])).toBe(checkboxes[index]);
    }

    await user.click(labels[1]);
    expect(onMarkViewedFile).toHaveBeenCalledOnce();
    expect(onMarkViewedFile).toHaveBeenCalledWith("src/bar.ts");
  });

  it("renders an image preview for binary image patches", () => {
    mocks.section = {
      oldFileName: "image.png",
      newFileName: "image.png",
      hunks: [
        `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`,
      ],
    };
    const { getByTestId, queryByText, queryByTestId } = render(
      <DiffFileBlock
        {...baseProps}
        file={{ ...baseProps.file, file: "image.png" }}
        isCollapsed={false}
      />,
    );
    expect(getByTestId("diff-image-view")).toHaveAttribute("data-file-path", "image.png");
    expect(queryByText("Binary file")).not.toBeInTheDocument();
    expect(queryByTestId("patch-diff-view")).not.toBeInTheDocument();
  });

  it("keeps the binary placeholder for non-image binary files", () => {
    mocks.section = {
      oldFileName: "archive.zip",
      newFileName: "archive.zip",
      hunks: [
        `diff --git a/archive.zip b/archive.zip
Binary files a/archive.zip and b/archive.zip differ
`,
      ],
    };
    const { getByText, queryByTestId } = render(
      <DiffFileBlock
        {...baseProps}
        file={{ ...baseProps.file, file: "archive.zip" }}
        isCollapsed={false}
      />,
    );
    expect(getByText("Binary file")).toBeInTheDocument();
    expect(queryByTestId("diff-image-view")).not.toBeInTheDocument();
  });

  it("gates a large text diff behind an opt-in instead of freezing on expand", async () => {
    // A patch with more changed lines than LARGE_DIFF_LINES (1500): rendering
    // it synchronously through Pierre would jank, so we show a placeholder.
    const bigHunkBody = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n");
    const bigPatch = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -0,0 +1,2000 @@
${bigHunkBody}
`;
    mocks.section = { oldFileName: "big.ts", newFileName: "big.ts", hunks: [bigPatch] };
    const { getByText, queryByTestId, getByRole, user } = render(
      <DiffFileBlock
        {...baseProps}
        file={{ ...baseProps.file, file: "big.ts", additions: 2000, deletions: 0 }}
        isCollapsed={false}
      />,
    );
    // Placeholder shown, fetch NOT enabled, Pierre NOT hydrated.
    expect(getByText("Large file")).toBeInTheDocument();
    expect(queryByTestId("patch-diff-view")).not.toBeInTheDocument();
    expect(mocks.useFileDiffSectionSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, allowLargeParse: false, isLargeByLines: true }),
    );

    // Explicit opt-in enables fetch + parse and renders progressively in bounded chunks.
    await user.click(getByRole("button", { name: "Display diff" }));
    const chunks = screen.getAllByTestId("patch-diff-view");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].getAttribute("data-patch")).toContain("diff --git a/big.ts b/big.ts");
    expect(chunks[0].getAttribute("data-patch")?.length).toBeLessThan(bigPatch.length);
  });

  it("keeps forceDisplay active when a deferred large-file fetch resolves asynchronously", async () => {
    const bigHunkBody = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n");
    const bigPatch = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -0,0 +1,2000 @@
${bigHunkBody}
`;
    mocks.section = null;
    mocks.isLoading = true;
    const props = {
      ...baseProps,
      file: { ...baseProps.file, file: "big.ts", additions: 2000, deletions: 0 },
      isCollapsed: false,
    };
    const { getByText, getByRole, rerender, user } = render(<DiffFileBlock {...props} />);
    expect(getByText("Large file")).toBeInTheDocument();

    await user.click(getByRole("button", { name: "Display diff" }));
    expect(getByText("Loading diff…")).toBeInTheDocument();

    // Fetch finishes asynchronously: section transitions from null → bigPatch.
    // Pass a fresh `file` object reference so React.memo re-renders with the updated mock.
    mocks.section = { oldFileName: "big.ts", newFileName: "big.ts", hunks: [bigPatch] };
    mocks.isLoading = false;
    rerender(<DiffFileBlock {...props} file={{ ...props.file }} />);
    expect(screen.getAllByTestId("patch-diff-view").length).toBeGreaterThan(0);
  });

  it("renders the placeholder when a small-line file has a deferred huge byte payload", async () => {
    mocks.isDeferredLarge = true;
    mocks.rawLength = 512_000;
    const { getByText, getByRole, queryByTestId, user } = render(
      <DiffFileBlock
        {...baseProps}
        file={{ ...baseProps.file, file: "bundle.min.js", additions: 1, deletions: 0 }}
        isCollapsed={false}
      />,
    );

    expect(getByText("Large file")).toBeInTheDocument();
    expect(getByText(/500\.0 KB/)).toBeInTheDocument();
    expect(queryByTestId("patch-diff-view")).not.toBeInTheDocument();

    await user.click(getByRole("button", { name: "Display diff" }));
    expect(screen.getByTestId("patch-diff-view")).toBeInTheDocument();
  });
});
