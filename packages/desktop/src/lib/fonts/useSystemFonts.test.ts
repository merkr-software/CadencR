// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSystemFonts } from "./useSystemFonts";
import * as mono from "./isMonospace";

function stubQueryLocalFonts(families: string[]): void {
  window.queryLocalFonts = () => Promise.resolve(families.map((family) => ({ family })));
}

afterEach(() => {
  vi.restoreAllMocks();
  delete window.queryLocalFonts;
});

describe("useSystemFonts", () => {
  it("does not query on mount", () => {
    stubQueryLocalFonts(["Menlo"]);
    const { result } = renderHook(() => useSystemFonts());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fonts).toEqual([]);
  });

  it("returns de-duplicated monospace families when showAll is false", async () => {
    stubQueryLocalFonts(["Menlo", "Menlo", "Arial", "Fira Code"]);
    vi.spyOn(mono, "isMonospace").mockImplementation((f) => f !== "Arial");

    const { result } = renderHook(() => useSystemFonts());
    act(() => result.current.load(false));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.fonts).toEqual(["Fira Code", "Menlo"]);
    expect(result.current.error).toBe(false);
  });

  it("returns all families when showAll is true", async () => {
    stubQueryLocalFonts(["Menlo", "Arial"]);
    const { result } = renderHook(() => useSystemFonts());
    act(() => result.current.load(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.fonts).toEqual(["Arial", "Menlo"]);
  });

  it("reuses the enumeration and the monospace measurements across loads", async () => {
    const query = vi.fn(() =>
      Promise.resolve([{ family: "Menlo" }, { family: "Arial" }, { family: "Menlo" }]),
    );
    window.queryLocalFonts = query;
    const isMonospaceSpy = vi.spyOn(mono, "isMonospace").mockImplementation((f) => f !== "Arial");

    const { result } = renderHook(() => useSystemFonts());
    act(() => result.current.load(false));
    await waitFor(() => expect(result.current.fonts).toEqual(["Menlo"]));

    act(() => result.current.load(true));
    expect(result.current.fonts).toEqual(["Arial", "Menlo"]);

    act(() => result.current.load(false));
    expect(result.current.fonts).toEqual(["Menlo"]);

    expect(query).toHaveBeenCalledTimes(1);
    // Two distinct families measured once each, despite three load() calls.
    expect(isMonospaceSpy).toHaveBeenCalledTimes(2);
  });

  it("sets error and empty list when the API is missing", async () => {
    const { result } = renderHook(() => useSystemFonts());
    act(() => result.current.load(false));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.fonts).toEqual([]);
    expect(result.current.error).toBe(true);
  });

  it("sets error when queryLocalFonts throws asynchronously", async () => {
    window.queryLocalFonts = () => Promise.reject(new Error("denied"));
    const { result } = renderHook(() => useSystemFonts());
    act(() => result.current.load(false));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  it("sets error when queryLocalFonts throws synchronously", async () => {
    window.queryLocalFonts = () => {
      throw new Error("Illegal invocation");
    };
    const { result } = renderHook(() => useSystemFonts());
    act(() => result.current.load(false));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  it("uses the window receiver when invoking queryLocalFonts", async () => {
    const queryLocalFonts = vi.fn(function queryLocalFonts(this: Window) {
      expect(this).toBe(window);
      return Promise.resolve([]);
    });
    window.queryLocalFonts = queryLocalFonts;
    const { result } = renderHook(() => useSystemFonts());
    act(() => result.current.load(false));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(queryLocalFonts).toHaveBeenCalledOnce();
  });

  it("sets error and empty list when entries are malformed", async () => {
    window.queryLocalFonts = () => Promise.resolve([{ family: 42 }] as never);
    const { result } = renderHook(() => useSystemFonts());
    act(() => result.current.load(false));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.fonts).toEqual([]);
    expect(result.current.error).toBe(true);
  });
});
