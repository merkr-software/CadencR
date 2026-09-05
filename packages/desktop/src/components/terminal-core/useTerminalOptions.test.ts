import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlacrittyConfigResponse } from "@/api/generated";
import { DEFAULT_MONO_STACK } from "@/lib/fonts/constants";
import { DEFAULT_TERMINAL_PALETTE } from "./terminal-palette";
import { resolveTerminalOptions, useTerminalOptions } from "./useTerminalOptions";

const query = vi.hoisted(() => ({
  data: undefined as AlacrittyConfigResponse | undefined,
  isLoading: false,
  error: null as Error | null,
}));
vi.mock("@/api/generated", () => ({ useAlacrittyConfigRoute: () => ({ ...query }) }));

describe("terminal options", () => {
  beforeEach(() => {
    query.data = { config: {}, found: false };
    query.isLoading = false;
    query.error = null;
  });

  it("preserves options identity across unrelated renders", () => {
    const { result, rerender } = renderHook(() => useTerminalOptions());
    const previous = result.current;
    rerender();
    expect(result.current).toBe(previous);
    expect(result.current.options?.font.family).toBe(DEFAULT_MONO_STACK);
  });

  it("updates live when the theme or selected font changes", () => {
    const { result, rerender } = renderHook((appearance) => useTerminalOptions(appearance), {
      initialProps: { palette: DEFAULT_TERMINAL_PALETTE, fontFamily: "first-font" },
    });
    const previous = result.current.options;
    const palette = { ...DEFAULT_TERMINAL_PALETTE, red: "#123456" };
    rerender({ palette, fontFamily: "second-font" });
    expect(result.current.options).not.toBe(previous);
    expect(result.current.options?.font.family).toBe("second-font");
    expect(result.current.options?.colors.red).toBe("#123456");
  });

  it("keeps the Cadencr theme when the server returns defaults without a config file", () => {
    const palette = { ...DEFAULT_TERMINAL_PALETTE, foreground: "#123456" };
    const options = resolveTerminalOptions(
      { found: false, config: { colors: { primary: { foreground: "#abcdef" } } } },
      { palette },
    );
    expect(options.colors.foreground).toBe("#123456");
    expect(options.cursor.blink).toBe(true);
  });

  it("applies explicit config colors but lets the chosen Cadencr font override its font", () => {
    const response = {
      found: true,
      config: {
        colors: { primary: { foreground: "#123456" } },
        font: { normal: { family: "config-font" }, size: 16 },
        scrolling: { history: 400 },
        cursor: { style: { shape: "Beam", blinking: "Always" } },
      },
    };
    const options = resolveTerminalOptions(response, { fontFamily: "chosen-font" });
    expect(options.colors.foreground).toBe("#123456");
    expect(options.font).toEqual({ family: "chosen-font", size: 16 });
    expect(options.cursor).toEqual({ style: "beam", blink: true });
    expect(options.scrollback).toBe(400);
    expect(resolveTerminalOptions(response).font.family).toBe("config-font");
  });

  it("keeps loading and configuration errors explicit", () => {
    query.data = undefined;
    query.isLoading = true;
    const { result, rerender } = renderHook(() => useTerminalOptions());
    expect(result.current).toEqual({ options: undefined, isLoading: true, error: null });
    query.isLoading = false;
    query.data = { config: {}, found: true, parse_error: "Invalid TOML" };
    rerender();
    expect(result.current).toEqual({ options: undefined, isLoading: false, error: "Invalid TOML" });
    query.error = new Error("Fetch failed");
    rerender();
    expect(result.current.error).toBe("Fetch failed");
  });
});
