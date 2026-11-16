import { describe, expect, it } from "vitest";
import type { PluginTabBackendBinary } from "@/api/generated";
import { pendingUpdateFixture, tabFixture } from "./custom-tabs-fixtures";
import { addedAccess, hasAdditions, nativeProgramChange, shortDigest } from "./update-changes";

const BACKEND = { protocol: 1, binary: { "darwin-aarch64": "bin/ports" }, reasoning: "Ports." };
const BINARY: PluginTabBackendBinary = {
  platform: "darwin-aarch64",
  protocol: 1,
  executable_sha256: "c".repeat(64),
};

describe("what a staged update changes", () => {
  it("lists only what the installed version does not ask for", () => {
    const added = addedAccess(
      tabFixture({ permissions: ["git:read"], commands: [{ program: "git", reasoning: "x" }] }),
      pendingUpdateFixture({
        permissions: ["git:read", "workspace:read"],
        commands: [
          { program: "git", reasoning: "x" },
          { program: "gh", reasoning: "y" },
        ],
      }),
    );
    expect([...added.permissions]).toEqual(["workspace:read"]);
    expect([...added.commands]).toEqual(["gh"]);
    expect(added.origins.size).toBe(0);
    expect(added.backend).toBe(true);
    expect(hasAdditions(added)).toBe(true);
  });

  it("finds no additions when the update asks for the same or less", () => {
    const tab = tabFixture({ backend: BACKEND, permissions: ["git:read", "features:read"] });
    const added = addedAccess(tab, pendingUpdateFixture({ permissions: ["git:read"] }));
    expect(hasAdditions(added)).toBe(false);
  });

  it("compares the installed and staged binaries", () => {
    const tab = tabFixture({ backend: BACKEND, backend_binary: BINARY });
    const same = pendingUpdateFixture({ backend_binary: BINARY });
    expect(nativeProgramChange(tab, same)).toBeNull();
    const rebuilt = { ...BINARY, executable_sha256: "d".repeat(64) };
    expect(nativeProgramChange(tab, pendingUpdateFixture({ backend_binary: rebuilt }))).toEqual({
      kind: "changed",
      from: BINARY,
      to: rebuilt,
    });
    const newer = { ...BINARY, protocol: 2 };
    expect(nativeProgramChange(tab, pendingUpdateFixture({ backend_binary: newer }))?.kind).toBe(
      "changed",
    );
    expect(nativeProgramChange(tab, pendingUpdateFixture({ backend: null }))).toEqual({
      kind: "removed",
    });
    expect(
      nativeProgramChange(tabFixture(), pendingUpdateFixture({ backend_binary: BINARY })),
    ).toEqual({ kind: "added", to: BINARY });
    expect(nativeProgramChange(tabFixture(), pendingUpdateFixture({ backend: null }))).toBeNull();
    // An unknown installed binary still reports the staged one.
    expect(
      nativeProgramChange(
        tabFixture({ backend: BACKEND }),
        pendingUpdateFixture({ backend_binary: BINARY }),
      ),
    ).toEqual({ kind: "changed", from: null, to: BINARY });
  });

  it("shortens a digest to 12 hex digits", () => {
    expect(shortDigest("0123456789abcdef".repeat(4))).toBe("0123456789ab");
  });
});
