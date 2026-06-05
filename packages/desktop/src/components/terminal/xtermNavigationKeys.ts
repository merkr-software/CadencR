import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

interface NavigationRefs {
  exitedRef: RefObject<boolean>;
  ptyIdRef: RefObject<string | null>;
  writeRef: RefObject<((data: string) => void) | null>;
}

export function attachXtermNavigationKeys(term: Terminal, refs: NavigationRefs): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    if (!refs.ptyIdRef.current || refs.exitedRef.current) return true;
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
