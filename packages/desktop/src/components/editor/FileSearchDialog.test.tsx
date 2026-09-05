import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import FileSearchDialog from "./FileSearchDialog";
import type { FileMatchResult, FileSearchResponse } from "@/api/generated";

const { mockFileSearch, mockOpenFile, mockOpenInNeovim } = vi.hoisted(() => ({
  mockFileSearch: vi.fn(),
  mockOpenFile: vi.fn(),
  mockOpenInNeovim: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useFileSearch: mockFileSearch,
}));

vi.mock("@/hooks/useEditorState", () => ({
  useEditorState: () => ({ activePaneId: "main", openFile: mockOpenFile }),
}));

// `undefined` unless the pane is actually showing Neovim — the hook's own
// contract. Tests that care about the Neovim route override the return value.
vi.mock("./neovim/useOpenFileInNeovim", () => ({
  useOpenFileInNeovim: () => mockOpenInNeovim(),
}));

vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: () => ({ value: "10" }),
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
    mockOpenInNeovim.mockReset();
    // Default: no Neovim pane, so opens go to the CodeMirror tab store.
    mockOpenInNeovim.mockReturnValue(undefined);
  });

  it("opens the clicked file", async () => {
    mockResult({ files: [file("src/alpha.ts"), file("src/beta.ts")] });
    renderDialog();
    await typeQuery();

    await userEvent.click(screen.getByText("beta.ts"));

    expect(mockOpenFile).toHaveBeenCalledWith("main", "src/beta.ts", 10);
  });

  it("opens the highlighted file when Enter is pressed", async () => {
    mockResult({ files: [file("src/alpha.ts"), file("src/beta.ts")] });
    renderDialog();
    await typeQuery();

    await userEvent.keyboard("{Enter}");

    expect(mockOpenFile).toHaveBeenCalledWith("main", "src/alpha.ts", 10);
  });

  it("routes to Neovim instead of the tab store when the pane shows Neovim", async () => {
    // Neovim owns its own buffers, so adding a tab to the editor store would
    // open the file into a pane nobody is looking at.
    const openInNeovim = vi.fn();
    mockOpenInNeovim.mockReturnValue(openInNeovim);
    mockResult({ files: [file("src/alpha.ts")] });
    renderDialog();
    await typeQuery();

    await userEvent.keyboard("{Enter}");

    expect(openInNeovim).toHaveBeenCalledWith("src/alpha.ts");
    expect(mockOpenFile).not.toHaveBeenCalled();
  });
});
