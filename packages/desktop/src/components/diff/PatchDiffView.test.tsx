import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import { PatchDiffView } from "./PatchDiffView";
import type { DiffLineAnnotation } from "@pierre/diffs";

interface AnnotationMetadata {
  comments?: unknown[];
  isActive?: boolean;
}

const mocks = vi.hoisted(() => {
  const hydrateMock = vi.fn();
  const renderMock = vi.fn();
  const setOptionsMock = vi.fn();
  const cleanUpMock = vi.fn();
  const getHoveredLineMock = vi.fn(() => ({ lineNumber: 2, side: "additions" }));
  const instances: unknown[] = [];
  class FileDiffMock {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }
    hydrate = hydrateMock;
    render = renderMock;
    setOptions = setOptionsMock;
    cleanUp = cleanUpMock;
    getHoveredLine = getHoveredLineMock;
  }
  return { FileDiffMock, hydrateMock, renderMock, setOptionsMock, cleanUpMock, instances };
});

vi.mock("@pierre/diffs", () => ({
  DIFFS_TAG_NAME: "diffs-container",
  FileDiff: mocks.FileDiffMock,
  VirtualizedFileDiff: mocks.FileDiffMock,
  registerCustomTheme: vi.fn(),
  areOptionsEqual: vi.fn(() => true),
  getSingularPatch: vi.fn((patch: string) => {
    if (patch.includes("\ndiff --git ")) {
      throw new Error("PatchDiff: Provided patch must include only 1 patch, with 1 diff");
    }
    return { name: "src/foo.ts", patch };
  }),
}));

vi.mock("@pierre/diffs/react", () => ({
  useVirtualizer: vi.fn(() => undefined),
  noopRender: vi.fn(),
  templateRender: (children: unknown) => children,
  renderDiffChildren: ({
    fileDiff,
    lineAnnotations,
    renderAnnotation,
    renderHeaderPrefix,
    renderHeaderMetadata,
  }: {
    fileDiff: { patch: string };
    lineAnnotations?: DiffLineAnnotation<AnnotationMetadata>[];
    renderAnnotation?: (annotation: DiffLineAnnotation<AnnotationMetadata>) => React.ReactNode;
    renderHeaderPrefix?: (fileDiff: { patch: string }) => React.ReactNode;
    renderHeaderMetadata?: (fileDiff: { patch: string }) => React.ReactNode;
  }) => (
    <div data-testid="pierre-patch" data-patch={fileDiff.patch}>
      {renderHeaderPrefix?.(fileDiff)}
      <span data-title>
        <bdi>src/foo.ts</bdi>
      </span>
      {renderHeaderMetadata?.(fileDiff)}
      {lineAnnotations?.map((annotation, index) => (
        <div key={`${annotation.side}-${annotation.lineNumber}-${index}`} data-testid="annotation">
          {renderAnnotation?.(annotation)}
        </div>
      ))}
    </div>
  ),
}));

const patch = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
+line2
 line3
`;

beforeEach(() => {
  mocks.hydrateMock.mockClear();
  mocks.renderMock.mockClear();
  mocks.setOptionsMock.mockClear();
  mocks.cleanUpMock.mockClear();
  mocks.instances.length = 0;
});

describe("PatchDiffView", () => {
  it("passes the supplied unified patch to Pierre without old/new content", () => {
    render(<PatchDiffView patch={patch} mode="unified" themeAppearance="dark" themeId="dracula" />);
    expect(screen.getByTestId("pierre-patch")).toHaveAttribute("data-patch", patch);
    expect(mocks.hydrateMock).toHaveBeenCalledWith(
      expect.objectContaining({ fileDiff: expect.objectContaining({ patch }) }),
    );
  });

  it("renders every file diff when given a multi-file patch", () => {
    const multiPatch = `${patch}diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1 +1 @@
-a
+b
`;

    render(
      <PatchDiffView patch={multiPatch} mode="unified" themeAppearance="dark" themeId="dracula" />,
    );

    const renderedPatches = screen.getAllByTestId("pierre-patch");
    expect(renderedPatches).toHaveLength(2);
    expect(renderedPatches[0]).toHaveAttribute("data-patch", patch.trimEnd());
    expect(renderedPatches[1]).toHaveAttribute(
      "data-patch",
      `diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1 +1 @@
-a
+b
`,
    );
  });
  it("supports split mode through Pierre options", () => {
    render(<PatchDiffView patch={patch} mode="split" themeAppearance="light" themeId="aurora" />);
    expect(mocks.setOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ diffStyle: "split" }),
    );
  });

  it("updates Pierre options without recreating the diff instance", () => {
    const { rerender } = render(
      <PatchDiffView patch={patch} mode="unified" themeAppearance="dark" themeId="dracula" />,
    );
    const initialHydrates = mocks.hydrateMock.mock.calls.length;
    const initialInstances = mocks.instances.length;

    rerender(<PatchDiffView patch={patch} mode="split" themeAppearance="dark" themeId="dracula" />);

    expect(mocks.instances).toHaveLength(initialInstances);
    expect(mocks.hydrateMock).toHaveBeenCalledTimes(initialHydrates);
    expect(mocks.setOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ diffStyle: "split" }),
    );
  });

  it("remounts Pierre when the patch changes to avoid stale async renders", () => {
    const { rerender } = render(
      <PatchDiffView patch={patch} mode="unified" themeAppearance="dark" themeId="dracula" />,
    );
    const initialInstances = mocks.instances.length;
    mocks.cleanUpMock.mockClear();

    const updatedPatch = patch.replace("+line2", "+updated line");
    rerender(
      <PatchDiffView
        patch={updatedPatch}
        mode="unified"
        themeAppearance="dark"
        themeId="dracula"
      />,
    );

    expect(mocks.cleanUpMock).toHaveBeenCalledOnce();
    expect(mocks.instances).toHaveLength(initialInstances + 1);
    expect(mocks.hydrateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileDiff: expect.objectContaining({ patch: updatedPatch }) }),
    );
  });

  it("passes the selected Cadencr theme to Pierre options", () => {
    render(<PatchDiffView patch={patch} mode="unified" themeAppearance="light" themeId="aurora" />);
    expect(mocks.setOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "cadencr-aurora-diff", themeType: "light" }),
    );
  });

  it("can disable Pierre's built-in header for externally headed inline diffs", () => {
    render(
      <PatchDiffView
        patch={patch}
        mode="unified"
        themeAppearance="dark"
        themeId="dracula"
        disableFileHeader
      />,
    );
    expect(mocks.setOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ disableFileHeader: true }),
    );
  });

  it("allows inline diffs to use compact hunk separators", () => {
    render(
      <PatchDiffView
        patch={patch}
        mode="unified"
        themeAppearance="dark"
        themeId="dracula"
        disableFileHeader
        hunkSeparators="simple"
      />,
    );

    expect(mocks.setOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ hunkSeparators: "simple" }),
    );
  });

  it("renders existing comments and an active comment form as line annotations", () => {
    render(
      <PatchDiffView
        patch={patch}
        mode="unified"
        themeAppearance="dark"
        themeId="dracula"
        commentLines={[
          {
            lineNumber: 2,
            comments: [
              {
                id: 1,
                feature_id: 1,
                file_path: "src/foo.ts",
                line_number: 2,
                side: "new",
                content: "Check this",
                status: "pending",
                created_at: "2026-05-17T10:00:00Z",
              },
            ],
          },
        ]}
        activeWidget={{ lineNumber: 3 }}
        commentCallbacks={{
          onSubmit: vi.fn(),
          onClose: vi.fn(),
          onEdit: vi.fn(),
          onDelete: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText("Check this")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add a comment...")).toBeInTheDocument();
  });

  it("uses Pierre's native gutter click API for comments without render utility callbacks", () => {
    const onAddComment = vi.fn();
    render(
      <PatchDiffView
        patch={patch}
        mode="unified"
        themeAppearance="dark"
        themeId="dracula"
        onAddComment={onAddComment}
      />,
    );

    const options = mocks.setOptionsMock.mock.calls.at(-1)?.[0] as {
      onGutterUtilityClick?: (range: { start: number; side?: "deletions" | "additions" }) => void;
      renderGutterUtility?: () => null;
      unsafeCSS?: string;
    };
    options.onGutterUtilityClick?.({ start: 2, side: "additions" });

    expect(onAddComment).toHaveBeenCalledWith(2, "new");
    expect(options.renderGutterUtility).toBeUndefined();
    expect(options.unsafeCSS).toContain("[data-utility-button]");
    expect(options.unsafeCSS).toContain("background-color: var(--primary)");
    expect(options.unsafeCSS).toContain("color: var(--primary-foreground)");
    expect(options.unsafeCSS).toContain(":host(.cadencr-patch-diff-inline) [data-code]");
  });
});
