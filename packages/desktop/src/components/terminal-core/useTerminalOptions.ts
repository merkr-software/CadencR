import { useMemo } from "react";
import {
  useAlacrittyConfigRoute,
  type AlacrittyConfigResponse,
  type AnsiPalette,
} from "@/api/generated";
import type { TerminalCursor, TerminalOptions, TerminalPalette } from "celeritty";
import { DEFAULT_TERMINAL_PALETTE } from "./terminal-palette";
import { DEFAULT_MONO_STACK } from "@/lib/fonts/constants";

export interface UseTerminalOptionsResult {
  options: TerminalOptions | undefined;
  isLoading: boolean;
  error: string | null;
}

interface TerminalAppearance {
  palette?: TerminalPalette;
  fontFamily?: string;
}

function applyNormalAnsi(target: TerminalPalette, source: AnsiPalette): void {
  target.black = source.black;
  target.red = source.red;
  target.green = source.green;
  target.yellow = source.yellow;
  target.blue = source.blue;
  target.magenta = source.magenta;
  target.cyan = source.cyan;
  target.white = source.white;
}

function applyBrightAnsi(target: TerminalPalette, source: AnsiPalette): void {
  target.brightBlack = source.black;
  target.brightRed = source.red;
  target.brightGreen = source.green;
  target.brightYellow = source.yellow;
  target.brightBlue = source.blue;
  target.brightMagenta = source.magenta;
  target.brightCyan = source.cyan;
  target.brightWhite = source.white;
}

/**
 * Alacritty writes cursor shapes capitalized ("Block", "Beam", "Underline");
 * the component's type is lowercase. Unrecognized shapes fall back to
 * "block" rather than rejecting an otherwise valid configuration.
 */
function cursorStyle(shape: string | null | undefined): TerminalCursor["style"] {
  switch ((shape ?? "").toLowerCase()) {
    case "beam":
      return "beam";
    case "underline":
      return "underline";
    default:
      return "block";
  }
}

/** `blinking` is "Off" | "On" | "Always" | "Never". Only "On"/"Always" mean the cursor blinks. */
function cursorBlink(blinking: string | null | undefined): boolean {
  const value = (blinking ?? "").toLowerCase();
  return value === "on" || value === "always";
}

/**
 * Resolve the backend's `AlacrittyConfigResponse` into `TerminalOptions`.
 *
 * The service only fills `colors.normal` (the 8 ANSI colors) with its own
 * fallback when the file doesn't set them — foreground, background, cursor
 * color and the 8 bright colors stay `undefined` when absent, and are filled
 * here from `DEFAULT_TERMINAL_PALETTE` (CadencR Dark's palette, the same
 * source the service's own fallback is copied from).
 */
export function resolveTerminalOptions(
  response: AlacrittyConfigResponse,
  appearance: TerminalAppearance = {},
): TerminalOptions {
  const config = response.config;
  const palette: TerminalPalette = { ...(appearance.palette ?? DEFAULT_TERMINAL_PALETTE) };

  if (response.found) {
    if (config.colors?.normal) applyNormalAnsi(palette, config.colors.normal);
    if (config.colors?.bright) applyBrightAnsi(palette, config.colors.bright);
    if (config.colors?.primary?.foreground) palette.foreground = config.colors.primary.foreground;
    if (config.colors?.primary?.background) palette.background = config.colors.primary.background;
    if (config.colors?.cursor?.cursor) palette.cursor = config.colors.cursor.cursor;
  }

  return {
    font: {
      family:
        appearance.fontFamily ??
        (response.found ? config.font?.normal?.family : undefined) ??
        DEFAULT_MONO_STACK,
      size: config.font?.size ?? 13,
    },
    colors: palette,
    cursor: {
      style: cursorStyle(config.cursor?.style?.shape),
      blink: response.found ? cursorBlink(config.cursor?.style?.blinking) : true,
    },
    scrollback: config.scrolling?.history ?? 10_000,
  };
}

/**
 * The one place that decides what the terminal looks like.
 *
 * The backend resolves the user's `alacritty.toml` (or reports that none was
 * found) and the service's own bundled palette fills anything the file
 * doesn't set. The component itself resolves nothing — it applies what this
 * hook produces.
 *
 * The selected Cadencr theme supplies the base palette. Explicit Alacritty
 * colors override it, and a chosen Cadencr monospace font wins over the
 * config's font family.
 */
export function useTerminalOptions(appearance: TerminalAppearance = {}): UseTerminalOptionsResult {
  const { data, isLoading, error: fetchError } = useAlacrittyConfigRoute();
  const { palette, fontFamily } = appearance;
  return useMemo(() => {
    if (fetchError) {
      const message =
        fetchError instanceof Error ? fetchError.message : "Failed to load terminal configuration";
      return { options: undefined, isLoading: false, error: message };
    }

    if (isLoading || !data) {
      return { options: undefined, isLoading: true, error: null };
    }

    if (data.parse_error) {
      // The file exists but failed to parse: `data.config` is defaults, not
      // the user's real settings. Surfacing this as an error rather than
      // silently rendering a theme the user never chose.
      return { options: undefined, isLoading: false, error: data.parse_error };
    }

    return {
      options: resolveTerminalOptions(data, { palette, fontFamily }),
      isLoading: false,
      error: null,
    };
  }, [data, isLoading, fetchError, palette, fontFamily]);
}
