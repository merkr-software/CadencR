// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), start: vi.fn() }));
vi.mock("@/api/generated", () => ({ openFileRoute: mocks.open, startRoute: mocks.start }));
import { builtinNeovimEditor } from "./editor-adapter";
const hosts: HTMLElement[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue({});
  mocks.start.mockResolvedValue({});
});
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});
function addEditor(featureId: number) {
  const host = document.createElement("div");
  host.dataset.neovimFeatureId = String(featureId);
  const input = document.createElement("textarea");
  host.append(input);
  document.body.append(host);
  hosts.push(host);
  return input;
}
describe("built-in Neovim adapter", () => {
  it("does not dispatch an obsolete opening after startup finishes", async () => {
    const reveal = vi.fn();
    await builtinNeovimEditor.open(2, { path: "old.rs" }, reveal, () => false);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });
  it("starts before revealing and opening, preserving one-based positions", async () => {
    const calls: string[] = [];
    mocks.start.mockImplementation(async () => {
      calls.push("start");
    });
    mocks.open.mockImplementation(async () => {
      calls.push("open");
    });
    await builtinNeovimEditor.open(2, { path: "src/main.rs", line: 7, column: 3 }, () => {
      calls.push("reveal");
    });
    expect(calls).toEqual(["start", "reveal", "open"]);
    expect(mocks.start).toHaveBeenCalledWith(2);
    expect(mocks.open).toHaveBeenCalledWith("2", { path: "src/main.rs", line: 7, col: 3 });
  });
  it("focuses the requested conversation rather than the first mounted editor", async () => {
    addEditor(1);
    const input = addEditor(2);
    await builtinNeovimEditor.focus(2);
    expect(document.activeElement).toBe(input);
  });
  it("waits for the lazy renderer input to mount", async () => {
    const focusing = builtinNeovimEditor.focus(2);
    const input = addEditor(2);
    await focusing;
    expect(document.activeElement).toBe(input);
  });
  it.each(["start", "open"] as const)(
    "propagates %s failure to the common controller",
    async (operation) => {
      mocks[operation].mockRejectedValueOnce(new Error("Unavailable"));
      const reveal = vi.fn();
      await expect(builtinNeovimEditor.open(2, { path: "main.rs" }, reveal)).rejects.toThrow(
        "Unavailable",
      );
      if (operation === "start") {
        expect(reveal).not.toHaveBeenCalled();
        expect(mocks.open).not.toHaveBeenCalled();
      } else expect(reveal).toHaveBeenCalledOnce();
    },
  );
});
