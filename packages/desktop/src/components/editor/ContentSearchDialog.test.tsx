import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import ContentSearchDialog from "./ContentSearchDialog";
import type { ContentMatch, ContentSearchResponse } from "@/api/generated";

const { mockContentSearch, mockOpenFile } = vi.hoisted(() => ({
  mockContentSearch: vi.fn(),
  mockOpenFile: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useContentSearch: mockContentSearch,
}));

vi.mock("@/hooks/useEditorState", () => ({
  useEditorState: () => ({ activePaneId: "main", openFile: mockOpenFile }),
}));

vi.mock("@/hooks/useSetting", () => ({
  useSetting: () => ({ value: "10" }),
}));

// Identity debounce so a typed query reaches the search params synchronously.
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: unknown) => value,
}));

// CodeMirror can't mount in jsdom; the group's result body is irrelevant here.
vi.mock("./SearchResultEditor", () => ({
  default: () => <div data-testid="result-editor" />,
}));

function match(path: string, line: number): ContentMatch {
  return {
    path,
    line_number: line,
    line_content: "match",
    context_before: [],
    context_after: [],
    match_start: 0,
    match_end: 5,
  };
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function searchResponse(overrides: Partial<ContentSearchResponse>): ContentSearchResponse {
  return {
    matches: [],
    truncated: false,
    skipped_large_files: 0,
    max_file_bytes: MAX_FILE_BYTES,
    ...overrides,
  };
}

function mockResult(
  response: ContentSearchResponse | undefined,
  flags: { isLoading?: boolean; isFetching?: boolean } = {},
): void {
  mockContentSearch.mockReturnValue({
    data: response,
    isLoading: flags.isLoading ?? false,
    isFetching: flags.isFetching ?? false,
  });
}

async function typeQuery(): Promise<void> {
  await userEvent.type(screen.getByPlaceholderText("Search in files..."), "foo");
}

function renderDialog(): void {
  render(<ContentSearchDialog projectId={1} featureId={1} open={true} onOpenChange={vi.fn()} />);
}

describe("ContentSearchDialog", () => {
  beforeEach(() => {
    mockContentSearch.mockReset();
    mockOpenFile.mockReset();
  });

  it("groups matches by file and shows the per-file match count", async () => {
    mockResult(
      searchResponse({
        matches: [match("src/a.ts", 10), match("src/a.ts", 20), match("src/b.ts", 5)],
      }),
    );
    renderDialog();
    await typeQuery();

    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    // a.ts has two matches, b.ts has one.
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders the truncated footer without crashing when results are capped", async () => {
    // Regression guard: the truncated path wires Virtuoso's `components`, which
    // previously crashed when handed `undefined`.
    mockResult(searchResponse({ matches: [match("src/a.ts", 1)], truncated: true }));
    renderDialog();
    await typeQuery();

    expect(screen.getByText(/Results capped at 500/)).toBeInTheDocument();
  });

  it("shows an empty state when a settled search returns no matches", async () => {
    mockResult(searchResponse({ matches: [] }));
    renderDialog();
    await typeQuery();

    expect(screen.getByText("No results found.")).toBeInTheDocument();
  });

  it("does not flash the empty state while a refetch is in flight", async () => {
    mockResult(searchResponse({ matches: [] }), { isFetching: true });
    renderDialog();
    await typeQuery();

    expect(screen.queryByText("No results found.")).not.toBeInTheDocument();
  });

  it("shows a file name holding a newline escaped the way git prints it", async () => {
    mockResult(searchResponse({ matches: [match("src/a\nb.txt", 3)] }));
    renderDialog();
    await typeQuery();

    expect(screen.getByText('src/"a\\nb.txt"')).toBeInTheDocument();
  });

  it("says how many files were too large to search, even with no match", async () => {
    mockResult(searchResponse({ matches: [], skipped_large_files: 2 }));
    renderDialog();
    await typeQuery();

    expect(screen.getByRole("status")).toHaveTextContent(
      "2 files larger than 5.0 MB not searched.",
    );
    expect(screen.getByText("No results found.")).toBeInTheDocument();
  });

  it("shows no size notice when every file was searched", async () => {
    mockResult(searchResponse({ matches: [match("src/a.ts", 1)] }));
    renderDialog();
    await typeQuery();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
