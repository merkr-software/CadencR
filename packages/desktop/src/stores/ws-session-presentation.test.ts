import { describe, expect, it, vi } from "vitest";
import {
  installSessionPresentationEffects,
  sessionPresentationEffects,
} from "./ws-session-presentation";

describe("session presentation composition", () => {
  it("fails clearly when the application has not installed its presentation effects", () => {
    expect(() => sessionPresentationEffects.onUserPromptDispatched(7)).toThrow(
      "have not been installed",
    );
  });

  it("rejects a second installation and delivers a dispatch exactly once", () => {
    const onUserPromptDispatched = vi.fn();
    const dispose = installSessionPresentationEffects({ onUserPromptDispatched });
    try {
      expect(() => installSessionPresentationEffects({ onUserPromptDispatched: vi.fn() })).toThrow(
        "already installed",
      );
      sessionPresentationEffects.onUserPromptDispatched(7);
      expect(onUserPromptDispatched).toHaveBeenCalledExactlyOnceWith(7);
    } finally {
      dispose();
    }
    expect(() => sessionPresentationEffects.onUserPromptDispatched(7)).toThrow(
      "have not been installed",
    );
  });

  it("does not let an old cleanup uninstall a new registration of the same effects", () => {
    const effects = { onUserPromptDispatched: vi.fn() };
    const oldCleanup = installSessionPresentationEffects(effects);
    oldCleanup();
    const cleanup = installSessionPresentationEffects(effects);
    try {
      oldCleanup();
      sessionPresentationEffects.onUserPromptDispatched(7);
      expect(effects.onUserPromptDispatched).toHaveBeenCalledExactlyOnceWith(7);
    } finally {
      cleanup();
    }
  });
});
