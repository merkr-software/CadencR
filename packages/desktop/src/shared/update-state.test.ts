import { describe, expect, it } from "vitest";
import {
  INITIAL_UPDATE_SNAPSHOT,
  reduceUpdateSnapshot,
  type UpdateEvent,
  type UpdateSnapshot,
} from "./update-state";

function fold(events: UpdateEvent[], from: UpdateSnapshot = INITIAL_UPDATE_SNAPSHOT) {
  return events.reduce(reduceUpdateSnapshot, from);
}

describe("reduceUpdateSnapshot", () => {
  it("marks the changelog as loading while a new version is downloading", () => {
    expect(fold([{ kind: "available", version: "0.2.0" }])).toMatchObject({
      status: "downloading",
      version: "0.2.0",
      changelogMarkdown: null,
      changelogLoading: true,
      progress: 0,
      error: null,
    });
  });

  it("stores the changelog markdown when it arrives for the current version", () => {
    const state = fold([
      { kind: "available", version: "0.2.0" },
      { kind: "changelog", version: "0.2.0", markdown: "# v0.2.0\n- thing" },
    ]);
    expect(state.changelogMarkdown).toBe("# v0.2.0\n- thing");
    expect(state.changelogLoading).toBe(false);
  });

  it("ignores stale changelog events for a different version", () => {
    const downloading = fold([{ kind: "available", version: "0.3.0" }]);
    const state = reduceUpdateSnapshot(downloading, {
      kind: "changelog",
      version: "0.2.0",
      markdown: "stale",
    });
    expect(state).toBe(downloading);
    expect(state.changelogLoading).toBe(true);
  });

  it("records a missing changelog (null) without losing version state", () => {
    const state = fold([
      { kind: "available", version: "0.2.0" },
      { kind: "changelog", version: "0.2.0", markdown: null },
    ]);
    expect(state).toMatchObject({ changelogMarkdown: null, changelogLoading: false });
    expect(state.version).toBe("0.2.0");
  });

  it("transitions to downloaded with progress=100 on the downloaded event", () => {
    const state = fold([
      { kind: "available", version: "0.2.0" },
      { kind: "download-progress", percent: 42.7, bytesPerSecond: 1_000 },
      { kind: "downloaded", version: "0.2.0" },
    ]);
    expect(state).toMatchObject({ status: "downloaded", progress: 100 });
  });

  it("clears the error and marks up-to-date on not-available", () => {
    const state = fold([
      { kind: "error", message: "old error" },
      { kind: "not-available", version: "0.1.2" },
    ]);
    expect(state).toMatchObject({ status: "up-to-date", error: null, version: "0.1.2" });
  });

  it("counts a revision per change and none for a repeated unsupported announce", () => {
    const unsupported: UpdateEvent = {
      kind: "unsupported",
      reason: "unsupported-install",
      message: "Use your package manager.",
    };
    const once = fold([{ kind: "checking" }, unsupported]);
    expect(once.revision).toBe(2);
    expect(reduceUpdateSnapshot(once, unsupported)).toBe(once);
  });

  it("publishes nothing for a repeated checking or an unchanged progress tick", () => {
    const checking = fold([{ kind: "checking" }]);
    expect(reduceUpdateSnapshot(checking, { kind: "checking" })).toBe(checking);
    const progress = fold([
      { kind: "available", version: "0.2.0" },
      { kind: "download-progress", percent: 10, bytesPerSecond: 1 },
    ]);
    expect(
      reduceUpdateSnapshot(progress, { kind: "download-progress", percent: 10, bytesPerSecond: 9 }),
    ).toBe(progress);
  });
});
