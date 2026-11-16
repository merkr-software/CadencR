import { describe, expect, it } from "vitest";
import { featurePathToGitPath, gitPathForAgent, gitPathToFeaturePath } from "./git-paths";

describe("git paths", () => {
  it("leaves paths alone for a project at the repository root", () => {
    expect(gitPathToFeaturePath("src/a.ts", "")).toBe("src/a.ts");
    expect(featurePathToGitPath("src/a.ts", "")).toBe("src/a.ts");
  });

  it("maps between checkout and monorepo-subdirectory paths", () => {
    expect(gitPathToFeaturePath("packages/app/readme.txt", "packages/app")).toBe("readme.txt");
    expect(featurePathToGitPath("readme.txt", "packages/app")).toBe("packages/app/readme.txt");
  });

  it("refuses files outside the feature's directory", () => {
    expect(gitPathToFeaturePath("README.md", "packages/app")).toBeNull();
    expect(gitPathToFeaturePath("packages/application/x.ts", "packages/app")).toBeNull();
    expect(gitPathToFeaturePath("packages/app/", "packages/app")).toBeNull();
  });

  it("names files for an agent running in the feature's directory", () => {
    const monorepo = { prefix: "packages/app", root: "/repo" };
    expect(gitPathForAgent("packages/app/src/a.ts", monorepo)).toBe("src/a.ts");
    // Outside the subdirectory a relative path would resolve under it.
    expect(gitPathForAgent("README.md", monorepo)).toBe("/repo/README.md");
    expect(gitPathForAgent("packages/application/x.ts", monorepo)).toBe(
      "/repo/packages/application/x.ts",
    );
    expect(gitPathForAgent("src/a.ts", { prefix: "", root: "/repo" })).toBe("src/a.ts");
  });
});
