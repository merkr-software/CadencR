import { translateUi } from "@/lib/i18n/ui";
import type { UpdateProjectRequest } from "@/api/generated";

/** What the project dialog changes: its name (and maybe its folder's), its
 * folder's place, or where a folder moved outside Cadencr went. */
export type ProjectLocationMode = "rename" | "move" | "locate";

export interface ProjectLocationDraft {
  mode: ProjectLocationMode;
  name: string;
  /** Rename only: also give the folder `folderName`. */
  renameFolder: boolean;
  folderName: string;
  /** Move only: the folder that will hold the project folder. */
  parent: string;
  /** Locate only: where the folder is now. */
  locatedPath: string;
}

/** The last segment of an absolute folder path. */
export function folderName(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}

/** The folder holding `path` ("/" for a top-level folder). */
export function parentFolder(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return `/${segments.slice(0, -1).join("/")}`;
}

export function joinFolder(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

/** A folder name for a project name: the same text, as one path segment. */
export function folderNameFor(projectName: string): string {
  return projectName.trim().replaceAll("/", "-");
}

export function folderNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0)
    return translateUi("project.location.folderNameRequired", "Enter a folder name.");
  if (trimmed.includes("/"))
    return translateUi("project.location.folderNameSlash", "A folder name cannot contain /.");
  if (trimmed === "." || trimmed === "..")
    return translateUi("project.location.folderNameInvalid", "Choose another folder name.");
  return null;
}

export function absolutePathError(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0)
    return translateUi("project.location.folderRequired", "Choose a folder.");
  if (!trimmed.startsWith("/"))
    return translateUi(
      "project.location.absolutePathRequired",
      "Enter an absolute path, starting with /.",
    );
  return null;
}

/** Why the draft cannot be submitted yet, or null when it can. */
export function draftError(draft: ProjectLocationDraft): string | null {
  switch (draft.mode) {
    case "rename":
      if (draft.name.trim().length === 0)
        return translateUi("project.location.projectNameRequired", "Enter a project name.");
      return draft.renameFolder ? folderNameError(draft.folderName) : null;
    case "move":
      return absolutePathError(draft.parent) ?? folderNameError(draft.folderName);
    case "locate":
      return absolutePathError(draft.locatedPath);
  }
}

/** Where the folder will be once the draft is applied (null: it stays). */
export function destinationOf(
  project: { path: string },
  draft: ProjectLocationDraft,
): string | null {
  switch (draft.mode) {
    case "rename": {
      if (!draft.renameFolder) return null;
      const target = joinFolder(parentFolder(project.path), draft.folderName.trim());
      return target === project.path ? null : target;
    }
    case "move": {
      const target = joinFolder(draft.parent.trim(), draft.folderName.trim());
      return target === project.path ? null : target;
    }
    case "locate":
      return draft.locatedPath.trim();
  }
}

/** The request applying the draft, or null when it changes nothing. */
export function updateRequestFor(
  project: { name: string; path: string },
  draft: ProjectLocationDraft,
): UpdateProjectRequest | null {
  const name = draft.mode === "rename" ? draft.name.trim() : project.name;
  const destination = destinationOf(project, draft);
  const request: UpdateProjectRequest = {};
  if (name !== project.name) request.name = name;
  if (destination !== null) {
    request.folder = { path: destination, mode: draft.mode === "locate" ? "locate" : "move" };
  }
  return request.name === undefined && request.folder === undefined ? null : request;
}
