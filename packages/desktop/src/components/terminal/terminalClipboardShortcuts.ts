import type { Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { desktopBridge } from "@/lib/desktop-bridge";

export function handleLinuxTerminalClipboardShortcut(
  terminal: Terminal,
  event: KeyboardEvent,
  options: { canPaste?: boolean } = {},
): boolean | null {
  if (event.type !== "keydown") return null;

  const action = terminalClipboardAction(event);
  if (action === null) return null;
  if (!isLinuxPlatform()) return null;

  event.preventDefault();
  event.stopPropagation();

  if (event.repeat) return false;
  if (action === "copy") void copyTerminalSelection(terminal);
  else if (options.canPaste === false) return false;
  else void pasteIntoTerminal(terminal);

  return false;
}

function terminalClipboardAction(event: KeyboardEvent): "copy" | "paste" | null {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null;

  const key = event.key.toLowerCase();
  if (key === "c") return "copy";
  if (key === "v") return "paste";
  return null;
}

async function copyTerminalSelection(terminal: Terminal): Promise<void> {
  const selection = terminal.getSelection();
  if (!selection) return;

  try {
    await writeClipboardText(selection);
    terminal.clearSelection();
  } catch {
    toast.error("Failed to copy terminal selection");
  }
}

async function pasteIntoTerminal(terminal: Terminal): Promise<void> {
  try {
    const text = await readClipboardText();
    if (text) terminal.paste(text);
  } catch {
    toast.error("Failed to paste into terminal");
  }
}

function readClipboardText(): Promise<string> {
  if (desktopBridge.readClipboardText) return desktopBridge.readClipboardText();
  return navigator.clipboard.readText();
}

function writeClipboardText(text: string): Promise<void> {
  if (desktopBridge.writeClipboardText) return desktopBridge.writeClipboardText(text);
  return navigator.clipboard.writeText(text);
}

function isLinuxPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /linux/i.test(platform);
}
