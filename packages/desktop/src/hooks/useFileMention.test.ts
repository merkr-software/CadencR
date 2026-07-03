import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { entries } = vi.hoisted(() => ({
  entries: [
    { path: "src", is_dir: true },
    { path: "src/components", is_dir: true },
    { path: "src/index.ts", is_dir: false },
    { path: "src/utils/helper.ts", is_dir: false },
    { path: "src/components/Button.tsx", is_dir: false },
    { path: "README.md", is_dir: false },
  ],
}));

const files = entries.map((e) => e.path);

// Stand in for the backend fuzzy-search endpoint: substring-filter the entry
// set by the query, and honour the `enabled` gate so the missing-project case
// behaves like a disabled query (no data).
vi.mock("@/api/generated", () => ({
  useFileSearch: (
    params: { query?: string | null },
    options?: { query?: { enabled?: boolean } },
  ) => {
    if (options?.query?.enabled === false) return { data: undefined };
    const q = (params.query ?? "").toLowerCase();
    const matched = entries.filter((e) => !q || e.path.toLowerCase().includes(q));
    return { data: { files: matched.map((e) => ({ ...e, positions: [] })) } };
  },
}));

import { useFileMention } from "./useFileMention";

const PARAMS = { projectId: 1, featureId: 2 };

type MentionHook = ReturnType<typeof useFileMention>;

// Type the result so we don't pull React types into the test signatures.
function open(result: { current: MentionHook }, text: string, cursor: number) {
  act(() => {
    result.current.handleChange(text, cursor);
  });
  // Flush the debounce so the query reaches the (mocked) backend.
  act(() => {
    vi.advanceTimersByTime(150);
  });
}

describe("useFileMention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.filteredItems).toEqual([]);
  });

  it("opens when @ is typed at start", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@", 1);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.query).toBe("");
  });

  it("opens with query when @src is typed", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@src", 4);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.query).toBe("src");
    expect(result.current.filteredItems.length).toBeGreaterThan(0);
    expect(result.current.filteredItems.every((i) => i.path.toLowerCase().includes("src"))).toBe(
      true,
    );
  });

  it("lists files and directories from the backend results", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@", 1);
    expect(result.current.filteredItems.length).toBe(files.length);
  });

  it("renders directories with a trailing slash", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@src", 4);
    const dirs = result.current.filteredItems.filter((i) => i.isDir);
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.every((d) => d.path.endsWith("/"))).toBe(true);
  });

  it("closes on close()", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@src", 4);
    act(() => {
      result.current.close();
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("closes when text does not start with @", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@src", 4);
    act(() => {
      result.current.handleChange("hello", 5);
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("closes when @ is not at start or after whitespace", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    act(() => {
      result.current.handleChange("foo@bar", 7);
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("confirm inserts selected file path", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@README", 7);
    let confirmed: { newText: string; newCursorPos: number } | null = null;
    act(() => {
      confirmed = result.current.confirm("@README");
    });
    expect(confirmed).not.toBeNull();
    expect(confirmed!.newText).toContain("README.md");
    expect(result.current.isOpen).toBe(false);
  });

  it("confirm returns null when not open", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    const res = result.current.confirm("hello");
    expect(res).toBeNull();
  });

  it("handles ArrowDown navigation", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@", 1);
    const initial = result.current.selectedIndex;
    act(() => {
      result.current.handleKeyDown(
        { key: "ArrowDown", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
        "@",
      );
    });
    expect(result.current.selectedIndex).toBe((initial + 1) % result.current.filteredItems.length);
  });

  it("handles ArrowUp navigation", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@", 1);
    act(() => {
      result.current.handleKeyDown(
        { key: "ArrowDown", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
        "@",
      );
    });
    const afterDown = result.current.selectedIndex;
    act(() => {
      result.current.handleKeyDown(
        { key: "ArrowUp", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
        "@",
      );
    });
    expect(result.current.selectedIndex).toBe(
      (afterDown - 1 + result.current.filteredItems.length) % result.current.filteredItems.length,
    );
  });

  it("handles Escape to close", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    open(result, "@", 1);
    act(() => {
      result.current.handleKeyDown(
        { key: "Escape", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
        "@",
      );
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("returns false from handleKeyDown when not open", () => {
    const { result } = renderHook(() => useFileMention(PARAMS));
    const res = result.current.handleKeyDown(
      { key: "ArrowDown", preventDefault: () => {} } as React.KeyboardEvent<HTMLTextAreaElement>,
      "",
    );
    expect(res).toBe(false);
  });

  it("yields no items when project scope is missing", () => {
    const { result } = renderHook(() =>
      useFileMention({ projectId: undefined, featureId: undefined }),
    );
    open(result, "@", 1);
    expect(result.current.filteredItems).toEqual([]);
  });
});
