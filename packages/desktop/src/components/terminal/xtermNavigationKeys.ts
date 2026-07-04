import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { handleLinuxTerminalClipboardShortcut } from "./terminalClipboardShortcuts";

interface NavigationRefs {
  exitedRef: RefObject<boolean>;
  ptyIdRef: RefObject<string | null>;
  writeRef: RefObject<((data: string) => void) | null>;
}

export function attachXtermNavigationKeys(term: Terminal, refs: NavigationRefs): void {
  term.attachCustomKeyEventHandler((event) => {
    const hasActivePty = Boolean(refs.ptyIdRef.current) && !refs.exitedRef.current;
    const clipboardResult = handleLinuxTerminalClipboardShortcut(term, event, {
      canPaste: hasActivePty,
    });
    if (clipboardResult !== null) return clipboardResult;

    if (event.type !== "keydown") return true;
    if (!hasActivePty) return true;
    const keyMap: Record<string, string> = {
      "meta+ArrowLeft": "\x01",
      "meta+ArrowRight": "\x05",
      "alt+ArrowLeft": "\x1bb",
      "alt+ArrowRight": "\x1bf",
    };
    const isOnlyMeta = event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
    const isOnlyAlt = event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
    const mod = isOnlyMeta ? "meta" : isOnlyAlt ? "alt" : "";
    const seq = mod ? keyMap[`${mod}+${event.key}`] : undefined;
    if (!seq) return true;
    refs.writeRef.current?.(seq);
    return false;
  });
}
