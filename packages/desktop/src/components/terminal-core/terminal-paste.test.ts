// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pasteTerminalText } from "./terminal-paste";

beforeEach(() => {
  vi.stubGlobal(
    "DataTransfer",
    class {
      private data = new Map<string, string>();
      setData(type: string, text: string) {
        this.data.set(type, text);
      }
      getData(type: string) {
        return this.data.get(type) ?? "";
      }
    },
  );
  vi.stubGlobal(
    "ClipboardEvent",
    class extends Event {
      readonly clipboardData: DataTransfer | null;
      constructor(type: string, options: ClipboardEventInit) {
        super(type, options);
        this.clipboardData = options.clipboardData ?? null;
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("native terminal clipboard routing", () => {
  it.each([true, false])(
    "delegates text and policy to the renderer (cancels default: %s)",
    (cancel) => {
      const host = document.createElement("div");
      const input = document.createElement("textarea");
      host.appendChild(input);
      const received: string[] = [];
      input.addEventListener("paste", (event) => {
        expect(event.bubbles).toBe(true);
        expect(event.cancelable).toBe(true);
        received.push(event.clipboardData?.getData("text/plain") ?? "");
        if (cancel) event.preventDefault();
        else event.stopPropagation();
      });
      pasteTerminalText(host, "é\n\x1b[201~payload");
      expect(received).toEqual(["é\n\x1b[201~payload"]);
    },
  );
  it("reports an unavailable input instead of bypassing the renderer", () => {
    expect(() => pasteTerminalText(null, "text")).toThrow("Terminal is not ready to paste");
    expect(() => pasteTerminalText(document.createElement("div"), "text")).toThrow(
      "Terminal is not ready to paste",
    );
  });
  it("ignores an empty clipboard", () => {
    expect(() => pasteTerminalText(null, "")).not.toThrow();
  });
});
