import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { handleAppSocketError } from "./app-socket-errors";

beforeEach(() => toastError.mockClear());

describe("handleAppSocketError", () => {
  it("surfaces a watcher failure with the service's actionable message", () => {
    const message = "inotify watch limit reached; raise fs.inotify.max_user_watches";
    expect(handleAppSocketError("session", "error", { code: "WATCHER_ERROR", message })).toBe(true);
    expect(toastError).toHaveBeenCalledWith("File watching stopped", {
      id: "app-socket-error:WATCHER_ERROR",
      description: message,
    });
  });

  it("surfaces unknown subscription errors too", () => {
    expect(handleAppSocketError("session", "error", {})).toBe(true);
    expect(toastError).toHaveBeenCalledWith(
      "Background update failed",
      expect.objectContaining({ id: "app-socket-error:unknown" }),
    );
  });

  it("ignores every other envelope", () => {
    expect(handleAppSocketError("app", "session_status.update", {})).toBe(false);
    expect(handleAppSocketError("git", "error", {})).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });
});
