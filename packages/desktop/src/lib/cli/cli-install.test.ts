import { describe, expect, it } from "vitest";
import { cliPathHint, describeCliConflict, describeCliInstall } from "./cli-install";

describe("describeCliInstall", () => {
  it("describes every state", () => {
    expect(describeCliInstall({ state: "unavailable", reason: "Dev build." })).toBe("Dev build.");
    expect(describeCliInstall({ state: "package", path: "/usr/bin/cadencr" })).toMatch(
      /package at \/usr\/bin\/cadencr/,
    );
    expect(
      describeCliInstall({
        state: "not-installed",
        target: "/usr/local/bin/cadencr",
        onPath: true,
      }),
    ).toMatch(/to \/usr\/local\/bin to open/);
    expect(
      describeCliInstall({
        state: "installed",
        target: "/usr/local/bin/cadencr",
        onPath: true,
        current: false,
      }),
    ).toMatch(/another copy/);
    expect(
      describeCliInstall({
        state: "conflict",
        target: "/usr/local/bin/cadencr",
        existing: "a link to /x",
        onPath: true,
      }),
    ).toMatch(/already exists: a link to \/x/);
  });
});

describe("describeCliConflict", () => {
  const status = {
    state: "conflict",
    target: "/usr/local/bin/cadencr",
    existing: "legacy description",
    onPath: true,
  } as const;

  it("uses structured details and preserves the foreign path", () => {
    expect(
      describeCliConflict({ ...status, conflict: { kind: "link", path: "/other command" } }),
    ).toBe("a link to /other command");
    expect(describeCliConflict({ ...status, conflict: { kind: "unmanaged-program" } })).toBe(
      "a program not installed by Cadencr",
    );
    expect(describeCliConflict({ ...status, conflict: { kind: "replaced-program" } })).toBe(
      "a program that replaced Cadencr's",
    );
    expect(describeCliConflict(status)).toBe("legacy description");
  });
});

describe("cliPathHint", () => {
  it("warns only when the command's directory is off PATH", () => {
    const target = "/home/me/.local/bin/cadencr";
    expect(cliPathHint({ state: "installed", target, onPath: true, current: true })).toBeNull();
    expect(cliPathHint({ state: "installed", target, onPath: false, current: true })).toMatch(
      /\/home\/me\/.local\/bin is not on/,
    );
    expect(cliPathHint({ state: "package", path: "/usr/bin/cadencr" })).toBeNull();
  });
});
