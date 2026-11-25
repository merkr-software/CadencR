import { translateUi } from "@/lib/i18n/ui";
/** Keep clipboard actions on the renderer's native paste path, including its
 * bracketed-paste mode and sanitization. Writing to the socket bypasses both. */
export function pasteTerminalText(host: HTMLElement | null, text: string): void {
  if (!text) return;
  const input = host?.querySelector("textarea");
  if (!input)
    throw new Error(
      translateUi(
        "workspace.tools.terminalPaste.terminalIsNotReadyToPaste",
        "Terminal is not ready to paste",
      ),
    );
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
}
