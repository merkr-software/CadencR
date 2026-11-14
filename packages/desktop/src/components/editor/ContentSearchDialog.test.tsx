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

vi.mock("@/hooks/useOpenEditorFile", () => ({
  useOpenEditorFile: () => mockOpenFile,
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
    mockResult({
      matches: [match("src/a.ts", 10), match("src/a.ts", 20), match("src/b.ts", 5)],
      truncated: false,
    });
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
    mockResult({ matches: [match("src/a.ts", 1)], truncated: true });
    renderDialog();
    await typeQuery();

    expect(screen.getByText(/Results capped at 500/)).toBeInTheDocument();
  });

  it("shows an empty state when a settled search returns no matches", async () => {
    mockResult({ matches: [], truncated: false });
    renderDialog();
    await typeQuery();

    expect(screen.getByText("No results found.")).toBeInTheDocument();
  });

  it("does not flash the empty state while a refetch is in flight", async () => {
    mockResult({ matches: [], truncated: false }, { isFetching: true });
    renderDialog();
    await typeQuery();

    expect(screen.queryByText("No results found.")).not.toBeInTheDocument();
  });
});
