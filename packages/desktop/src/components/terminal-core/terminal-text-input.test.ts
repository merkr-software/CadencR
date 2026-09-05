import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "celeritty";
import { attachTerminalTextInput } from "./terminal-text-input";

function setup() {
  const host = document.createElement("div");
  host.tabIndex = 0;
  document.body.appendChild(host);
  const write = vi.fn();
  const terminal = Object.create(Terminal.prototype) as Terminal;
  Object.defineProperty(terminal, "transport", { value: { write } });
  const dispose = attachTerminalTextInput(host, terminal);
  const input = host.querySelector("textarea")!;
  return { host, input, write, dispose };
}
afterEach(() => {
  document.body.replaceChildren();
});

describe("terminal native text input", () => {
  it("focuses a native input and forwards virtual keyboard edits", () => {
    const { host, input, write } = setup();
    host.focus();
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new InputEvent("input", { data: "hello 世界", inputType: "insertText" }));
    input.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward" }));
    input.dispatchEvent(new InputEvent("input", { inputType: "insertLineBreak" }));
    expect(write.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      "hello 世界",
      "\x7f",
      "\r",
    ]);
    expect(input.value).toBe("");
  });
  it("sends only committed IME text, not partial keydown or duplicate final input", async () => {
    const { host, input, write } = setup();
    const hostKey = vi.fn();
    host.addEventListener("keydown", hostKey);
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, isComposing: true }),
    );
    input.dispatchEvent(new InputEvent("input", { data: "あ", isComposing: true }));
    expect(write).not.toHaveBeenCalled();
    expect(hostKey).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent("compositionend", { data: "あ" }));
    input.dispatchEvent(
      new InputEvent("input", { data: "あ", inputType: "insertFromComposition" }),
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(write.mock.calls[0][0])).toBe("あ");
    await Promise.resolve();
    input.dispatchEvent(new InputEvent("input", { data: "x", inputType: "insertText" }));
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("leaves ordinary keyboard encoding to the terminal and removes its surface", () => {
    const { host, input, write, dispose } = setup();
    const listener = vi.fn();
    host.addEventListener("keydown", listener);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    dispose();
    expect(host.querySelector("textarea")).toBeNull();
    host.focus();
    expect(document.activeElement).toBe(host);
  });
});
