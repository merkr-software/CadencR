import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import FileSearchDialog from "./FileSearchDialog";
import type { FileMatchResult, FileSearchResponse } from "@/api/generated";

const { mockFileSearch, mockOpenFile } = vi.hoisted(() => ({
  mockFileSearch: vi.fn(),
  mockOpenFile: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useFileSearch: mockFileSearch,
}));

vi.mock("@/hooks/useOpenEditorFile", () => ({
  useOpenEditorFile: () => mockOpenFile,
}));

// Identity debounce so a typed query reaches the search params synchronously.
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: unknown) => value,
}));

function file(path: string): FileMatchResult {
  return { path, positions: [], is_dir: false };
}

function mockResult(response: FileSearchResponse | undefined): void {
  mockFileSearch.mockReturnValue({ data: response, isLoading: false });
}

function renderDialog(): void {
  render(<FileSearchDialog projectId={1} featureId={1} open={true} onOpenChange={vi.fn()} />);
}

async function typeQuery(): Promise<void> {
  await userEvent.type(screen.getByPlaceholderText("Search files..."), "a");
}

describe("FileSearchDialog", () => {
  beforeEach(() => {
    mockFileSearch.mockReset();
    mockOpenFile.mockReset();
  });

  it("opens the clicked file", async () => {
    mockResult({ files: [file("src/alpha.ts"), file("src/beta.ts")] });
    renderDialog();
    await typeQuery();

    await userEvent.click(screen.getByText("beta.ts"));

    expect(mockOpenFile).toHaveBeenCalledWith("src/beta.ts");
  });

  it("opens the highlighted file when Enter is pressed", async () => {
    mockResult({ files: [file("src/alpha.ts"), file("src/beta.ts")] });
    renderDialog();
    await typeQuery();

    await userEvent.keyboard("{Enter}");

    expect(mockOpenFile).toHaveBeenCalledWith("src/alpha.ts");
  });
});
