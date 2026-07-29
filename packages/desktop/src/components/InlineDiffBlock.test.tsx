import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { getDiffRenderDiagnostics } from "@/lib/diff-render-diagnostics";
import { InlineDiffBlock } from "./InlineDiffBlock";

const mocks = vi.hoisted(() => ({
  patchDiffViewMock: vi.fn(
    ({
      patch,
      className,
      hunkSeparators,
    }: {
      patch: string;
      className?: string;
      disableFileHeader?: boolean;
      hunkSeparators?: string;
    }) => (
      <div
        data-testid="diff-view"
        data-class-name={className}
        data-hunk-separators={hunkSeparators}
        data-patch={patch}
      >
        diff content
      </div>
    ),
  ),
}));

vi.mock("@/components/diff/PatchDiffView", () => ({
  PatchDiffView: (props: Parameters<typeof mocks.patchDiffViewMock>[0]) =>
    mocks.patchDiffViewMock(props),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ theme: { id: "dracula", appearance: "dark" } }),
}));

describe("InlineDiffBlock", () => {
  it("shows 'No changes' when content is identical", () => {
    render(
      <InlineDiffBlock filePath="src/foo.ts" oldContent="const x = 1;" newContent="const x = 1;" />,
    );
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("renders file path when content differs", () => {
    render(
      <InlineDiffBlock
        filePath="src/example.ts"
        oldContent="const x = 1;"
        newContent="const x = 2;"
      />,
    );
    expect(screen.getByText("src/example.ts")).not.toHaveAttribute("title");
  });

  it("shows diff view when content differs", () => {
    render(
      <InlineDiffBlock
        filePath="test.ts"
        oldContent={"line1\nline2\n"}
        newContent={"line1\nline3\n"}
      />,
    );
    expect(screen.getByTestId("diff-view")).toBeInTheDocument();
  });

  it("displays addition and deletion counts", () => {
    render(
      <InlineDiffBlock filePath="test.ts" oldContent={"a\nb\nc\n"} newContent={"a\nx\ny\nc\n"} />,
    );
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
  });

  it("strips basePath from displayed file path", () => {
    render(
      <InlineDiffBlock
        filePath="/home/user/project/src/foo.ts"
        oldContent="old"
        newContent="new"
        basePath="/home/user/project"
      />,
    );
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });

  it("calls edit handler with the file path and first changed line", async () => {
    const onOpenFileInEditor = vi.fn();
    const { user } = render(
      <InlineDiffBlock
        filePath="/home/user/project/src/foo.ts"
        oldContent={"one\ntwo\nthree\n"}
        newContent={"one\nTWO\nthree\n"}
        basePath="/home/user/project"
        toolName="Edit"
        onOpenFileInEditor={onOpenFileInEditor}
      />,
    );

    const editButton = screen.getByRole("button", { name: "Edit src/foo.ts in editor" });
    expect(editButton).not.toHaveAttribute("title");
    await user.click(editButton);

    expect(onOpenFileInEditor).toHaveBeenCalledWith("/home/user/project/src/foo.ts", 2);
  });
});

it("passes a unified patch to the shared diff renderer", () => {
  render(
    <InlineDiffBlock
      filePath="test.ts"
      oldContent={"one\ntwo\nthree\n"}
      newContent={"one\nTWO\nthree\n"}
    />,
  );
  expect(screen.getByTestId("diff-view")).toHaveAttribute(
    "data-patch",
    expect.stringContaining("@@ -1,3 +1,3 @@"),
  );
});

it("keeps the agent tool-call header instead of Pierre's file header", () => {
  render(
    <InlineDiffBlock
      filePath="test.ts"
      oldContent={"one\n"}
      newContent={"two\n"}
      toolName="Edit"
    />,
  );
  expect(screen.getByText("Edit")).toBeInTheDocument();
  expect(mocks.patchDiffViewMock).toHaveBeenCalledWith(
    expect.objectContaining({ disableFileHeader: true }),
  );
});

it("uses compact Pierre hunk separators for inline diffs", () => {
  render(
    <InlineDiffBlock
      filePath="test.ts"
      oldContent={"one\n"}
      newContent={"two\n"}
      toolName="Edit"
    />,
  );

  expect(mocks.patchDiffViewMock).toHaveBeenCalledWith(
    expect.objectContaining({ hunkSeparators: "simple" }),
  );
  expect(screen.getByTestId("diff-view")).toHaveAttribute(
    "data-class-name",
    expect.stringContaining("cadencr-patch-diff-inline"),
  );
});

describe("InlineDiffBlock controlled expand API", () => {
  it("hides the diff body when controlled `expanded` is false", () => {
    render(
      <InlineDiffBlock
        filePath="test.ts"
        oldContent={"one\n"}
        newContent={"two\n"}
        expanded={false}
      />,
    );
    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
  });

  it("renders the diff body when controlled `expanded` is true", () => {
    render(
      <InlineDiffBlock
        filePath="test.ts"
        oldContent={"one\n"}
        newContent={"two\n"}
        expanded={true}
      />,
    );
    expect(screen.getByTestId("diff-view")).toBeInTheDocument();
  });

  it("calls onExpandedChange with the next state when the chevron is clicked", async () => {
    const onExpandedChange = vi.fn();
    const { user } = render(
      <InlineDiffBlock
        filePath="test.ts"
        oldContent={"one\n"}
        newContent={"two\n"}
        expanded={true}
        onExpandedChange={onExpandedChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Collapse diff" }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("toggles when the user clicks anywhere on the collapsed header row", async () => {
    // Click-the-whole-row is the affordance we ship for the collapsed
    // verbosity modes — without it, only the tiny chevron is hit-testable.
    const onExpandedChange = vi.fn();
    const { user } = render(
      <InlineDiffBlock
        filePath="test.ts"
        oldContent={"one\n"}
        newContent={"two\n"}
        expanded={false}
        onExpandedChange={onExpandedChange}
      />,
    );
    await user.click(screen.getByTestId("inline-diff-header"));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it("does not toggle when the inner 'Edit in editor' button is clicked", async () => {
    // The Edit button lives inside the clickable header row; if it didn't
    // stopPropagation we would collapse the diff every time the user
    // tried to jump to the editor.
    const onExpandedChange = vi.fn();
    const onOpenFileInEditor = vi.fn();
    const { user } = render(
      <InlineDiffBlock
        filePath="src/foo.ts"
        oldContent={"one\n"}
        newContent={"two\n"}
        expanded={true}
        onExpandedChange={onExpandedChange}
        onOpenFileInEditor={onOpenFileInEditor}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit src/foo.ts in editor" }));
    expect(onOpenFileInEditor).toHaveBeenCalled();
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it("stays expanded when no `expanded` prop is provided (legacy callers)", () => {
    render(<InlineDiffBlock filePath="test.ts" oldContent={"one\n"} newContent={"two\n"} />);
    expect(screen.getByTestId("diff-view")).toBeInTheDocument();
  });
});

describe("InlineDiffBlock large diff safety", () => {
  const oldContent = Array.from({ length: 751 }, (_, index) => `old line ${index}`).join("\n");
  const newContent = Array.from({ length: 751 }, (_, index) => `new line ${index}`).join("\n");

  it("keeps a large diff collapsed even when transcript verbosity requests expansion", () => {
    render(
      <InlineDiffBlock
        filePath="generated.ts"
        oldContent={oldContent}
        newContent={newContent}
        expanded
      />,
    );

    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand diff" })).toBeInTheDocument();
  });

  it("uses a plain-text renderer when the user explicitly expands a large diff", async () => {
    const onExpandedChange = vi.fn();
    const { user } = render(
      <InlineDiffBlock
        filePath="generated.ts"
        oldContent={oldContent}
        newContent={newContent}
        expanded
        onExpandedChange={onExpandedChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand diff" }));

    expect(screen.getByText(/Large diff shown without syntax highlighting/)).toBeInTheDocument();
    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it("uses UTF-8 bytes to classify and label multibyte content", async () => {
    const cjkContent = "界".repeat(70_000);
    const { user } = render(
      <InlineDiffBlock
        filePath="translations.txt"
        oldContent=""
        newContent={cjkContent}
        expanded
      />,
    );

    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand diff" }));
    expect(screen.getByText(/about 205\.\d KB/)).toBeInTheDocument();
  });

  it("does not count streamed large-patch updates as remounts", async () => {
    const before = getDiffRenderDiagnostics();
    const { user, rerender } = render(
      <InlineDiffBlock
        filePath="generated.ts"
        oldContent={oldContent}
        newContent={newContent}
        expanded
      />,
    );
    await user.click(screen.getByRole("button", { name: "Expand diff" }));
    const afterMount = getDiffRenderDiagnostics();

    rerender(
      <InlineDiffBlock
        filePath="generated.ts"
        oldContent={oldContent}
        newContent={`${newContent}\nstreamed tail`}
        expanded
      />,
    );
    const afterUpdate = getDiffRenderDiagnostics();

    expect(afterMount.heavyInlineMounts - before.heavyInlineMounts).toBe(1);
    expect(afterUpdate.heavyInlineMounts).toBe(afterMount.heavyInlineMounts);
    expect(afterUpdate.heavyInlineMounted).toBe(afterMount.heavyInlineMounted);
    expect(afterUpdate.heavyInlineVisible).toBe(afterMount.heavyInlineVisible);
  });
});

it("uses the theme-owned file-change identity for edit tool-call headers", () => {
  render(
    <InlineDiffBlock
      filePath="test.ts"
      oldContent={"one\n"}
      newContent={"two\n"}
      toolName="ApplyPatch"
    />,
  );

  expect(screen.getByText("ApplyPatch")).toHaveClass(
    "text-[var(--block-edit-accent,var(--numstat-add-fg))]",
  );
  expect(screen.getByTestId("inline-diff-header")).toHaveClass(
    "bg-[color-mix(in_srgb,var(--block-edit-accent,var(--numstat-add-fg))_15%,var(--editor-bg))]",
  );
});
