import type { TerminalPalette } from "celeritty";
import { CADENCR_DARK_THEME } from "@/lib/themes/cadencr-dark";

/**
 * Base palette used when the backend has nothing to fall back to either
 * (no `alacritty.toml`, and no override). Mirrors the eight ANSI colors the
 * service itself hardcodes as `AppState.fallback_palette`
 * (`packages/service/src/app_state.rs`) — same values, so there is no visual
 * discontinuity between "no config" and "config exists but is silent about
 * colors" states.
 *
 * `XTermPalette` (CadencR's theme type) and `TerminalPalette` (celeritty's)
 * carry the same sixteen ANSI slots plus foreground/background/cursor; only
 * `cursorAccent`, `selectionBackground` etc. from `XTermPalette` are dropped.
 */
export const DEFAULT_TERMINAL_PALETTE: TerminalPalette = {
  black: CADENCR_DARK_THEME.xterm.black,
  red: CADENCR_DARK_THEME.xterm.red,
  green: CADENCR_DARK_THEME.xterm.green,
  yellow: CADENCR_DARK_THEME.xterm.yellow,
  blue: CADENCR_DARK_THEME.xterm.blue,
  magenta: CADENCR_DARK_THEME.xterm.magenta,
  cyan: CADENCR_DARK_THEME.xterm.cyan,
  white: CADENCR_DARK_THEME.xterm.white,
  brightBlack: CADENCR_DARK_THEME.xterm.brightBlack,
  brightRed: CADENCR_DARK_THEME.xterm.brightRed,
  brightGreen: CADENCR_DARK_THEME.xterm.brightGreen,
  brightYellow: CADENCR_DARK_THEME.xterm.brightYellow,
  brightBlue: CADENCR_DARK_THEME.xterm.brightBlue,
  brightMagenta: CADENCR_DARK_THEME.xterm.brightMagenta,
  brightCyan: CADENCR_DARK_THEME.xterm.brightCyan,
  brightWhite: CADENCR_DARK_THEME.xterm.brightWhite,
  foreground: CADENCR_DARK_THEME.xterm.foreground,
  background: CADENCR_DARK_THEME.xterm.background,
  cursor: CADENCR_DARK_THEME.xterm.cursor,
};
