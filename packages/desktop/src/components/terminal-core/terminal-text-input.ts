import type { TerminalEngine as Terminal } from "./terminal-engine";

/** Canvas terminals still need a native text surface for IME and mobile keyboards. */
export function attachTerminalTextInput(host: HTMLElement, terminal: Terminal): () => void {
  const input = host.ownerDocument.createElement("textarea");
  input.setAttribute("aria-label", "Terminal input");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocomplete", "off");
  input.spellcheck = false;
  Object.assign(input.style, {
    position: "absolute",
    bottom: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    padding: "0",
    border: "0",
    resize: "none",
  });
  host.appendChild(input);
  let composing = false;
  let committedInTask = false;
  const encoder = new TextEncoder();
  const send = (text: string): void => {
    if (text) terminal.transport?.write(encoder.encode(text));
  };
  const focus = (event: FocusEvent): void => {
    if (event.target === host) input.focus({ preventScroll: true });
  };
  const keydown = (event: KeyboardEvent): void => {
    if (composing || event.isComposing || event.key === "Process" || event.keyCode === 229) {
      // Let the native editor compose, but do not send partial keys to the PTY.
      event.stopImmediatePropagation();
    }
  };
  const compositionStart = (): void => {
    composing = true;
  };
  const compositionEnd = (event: CompositionEvent): void => {
    composing = false;
    committedInTask = true;
    send(event.data);
    input.value = "";
    queueMicrotask(() => {
      committedInTask = false;
    });
  };
  const onInput = (event: Event): void => {
    if (!(event instanceof InputEvent) || composing || event.isComposing) return;
    if (!committedInTask) {
      if (event.inputType === "deleteContentBackward") send("\x7f");
      else if (event.inputType === "insertLineBreak") send("\r");
      else send(event.data ?? input.value);
    }
    input.value = "";
  };
  const paste = (event: ClipboardEvent): void => {
    if (event.defaultPrevented) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text == null) return;
    event.preventDefault();
    send(text);
  };
  host.addEventListener("focus", focus, true);
  host.addEventListener("keydown", keydown, true);
  input.addEventListener("compositionstart", compositionStart);
  input.addEventListener("compositionend", compositionEnd);
  input.addEventListener("input", onInput);
  input.addEventListener("paste", paste);
  if (host.ownerDocument.activeElement === host) input.focus({ preventScroll: true });
  return () => {
    host.removeEventListener("focus", focus, true);
    host.removeEventListener("keydown", keydown, true);
    input.remove();
  };
}
