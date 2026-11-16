import { describe, it, expect } from "vitest";
import { relativeToProject } from "./relative-path";

describe("relativeToProject", () => {
  it("strips a POSIX-style project root prefix", () => {
    expect(relativeToProject("/home/me/proj/src/foo.ts", "/home/me/proj")).toBe("src/foo.ts");
  });

  it("handles a trailing slash on the project root or the path", () => {
    expect(relativeToProject("/home/me/proj/notes.md", "/home/me/proj/")).toBe("notes.md");
    expect(relativeToProject("/home/me/proj/", "/home/me/proj")).toBe("");
  });

  it("strips a Windows-style project root prefix", () => {
    expect(relativeToProject("C:\\proj\\src\\foo.ts", "C:\\proj")).toBe("src\\foo.ts");
  });

  it("returns null for a path outside the project root", () => {
    expect(relativeToProject("/tmp/outside.txt", "/home/me/proj")).toBeNull();
  });

  it("rejects a near-miss prefix (sibling directory)", () => {
    // `/home/me/projectile/foo.ts` is NOT under `/home/me/proj`.
    expect(relativeToProject("/home/me/projectile/foo.ts", "/home/me/proj")).toBeNull();
  });

  it("returns empty string when absPath equals the project root", () => {
    expect(relativeToProject("/home/me/proj", "/home/me/proj")).toBe("");
  });

  it("treats the filesystem root as containing everything", () => {
    expect(relativeToProject("/etc/hosts", "/")).toBe("etc/hosts");
    expect(relativeToProject("/", "/")).toBe("");
  });
});
