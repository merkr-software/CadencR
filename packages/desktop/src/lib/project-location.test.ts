import { describe, expect, it } from "vitest";
import {
  destinationOf,
  draftError,
  folderName,
  folderNameFor,
  parentFolder,
  updateRequestFor,
  type ProjectLocationDraft,
} from "./project-location";

const project = { name: "app", path: "/Users/me/code/app" };

function draft(overrides: Partial<ProjectLocationDraft>): ProjectLocationDraft {
  return {
    mode: "rename",
    name: "app",
    renameFolder: true,
    folderName: "app",
    parent: "",
    locatedPath: "",
    ...overrides,
  };
}

describe("project folder paths", () => {
  it("splits a folder path into its parent and name", () => {
    expect(folderName("/Users/me/code/app/")).toBe("app");
    expect(parentFolder("/Users/me/code/app")).toBe("/Users/me/code");
    expect(parentFolder("/app")).toBe("/");
  });

  it("turns a project name into one folder name", () => {
    expect(folderNameFor("  Front/Back  ")).toBe("Front-Back");
  });
});

describe("project update requests", () => {
  it("renames the project and its folder side by side", () => {
    const request = updateRequestFor(project, draft({ name: "Shop", folderName: "shop" }));
    expect(request).toEqual({
      name: "Shop",
      folder: { path: "/Users/me/code/shop", mode: "move" },
    });
  });

  it("renames only the project when the folder keeps its name", () => {
    expect(updateRequestFor(project, draft({ name: "Shop", renameFolder: false }))).toEqual({
      name: "Shop",
    });
    expect(updateRequestFor(project, draft({ name: "Shop", folderName: "app" }))).toEqual({
      name: "Shop",
    });
  });

  it("moves the folder into another parent", () => {
    const move = draft({ mode: "move", parent: "/Volumes/Work/", folderName: "app" });
    expect(destinationOf(project, move)).toBe("/Volumes/Work/app");
    expect(updateRequestFor(project, move)).toEqual({
      folder: { path: "/Volumes/Work/app", mode: "move" },
    });
  });

  it("has nothing to send when the folder would stay where it is", () => {
    const stay = draft({ mode: "move", parent: "/Users/me/code/", folderName: "app" });
    expect(destinationOf(project, stay)).toBeNull();
    expect(updateRequestFor(project, stay)).toBeNull();
  });

  it("records where a folder moved outside Cadencr went", () => {
    const locate = draft({ mode: "locate", locatedPath: " /Users/me/elsewhere/app " });
    expect(updateRequestFor(project, locate)).toEqual({
      folder: { path: "/Users/me/elsewhere/app", mode: "locate" },
    });
  });

  it("changes nothing when nothing changed", () => {
    expect(updateRequestFor(project, draft({}))).toBeNull();
  });

  it("explains what is missing before submitting", () => {
    expect(draftError(draft({ name: " " }))).toBe("Enter a project name.");
    expect(draftError(draft({ folderName: "a/b" }))).toBe("A folder name cannot contain /.");
    expect(draftError(draft({ mode: "move", parent: "relative", folderName: "app" }))).toBe(
      "Enter an absolute path, starting with /.",
    );
    expect(draftError(draft({ mode: "locate", locatedPath: "" }))).toBe("Choose a folder.");
    expect(draftError(draft({ name: "Shop", folderName: "shop" }))).toBeNull();
  });
});
