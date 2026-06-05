import { Terminal } from "@xterm/xterm";
import type { XTermPalette } from "@/lib/themes";

export function createXtermInstance(theme: XTermPalette): Terminal {
  return new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    cursorWidth: 2,
    fontSize: 13,
    lineHeight: 1.2,
    fontFamily:
      "'FiraCode Nerd Font', 'Fira Code', 'CaskaydiaCove Nerd Font', 'Cascadia Code', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    fontWeight: "400",
    fontWeightBold: "600",
    letterSpacing: 0,
    theme,
    macOptionIsMeta: true,
    allowProposedApi: true,
    scrollback: 5000,
  });
}
