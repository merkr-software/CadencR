import type { ChangedFile } from "@cadencr/tab-sdk/api";

/** What a tile's color and glyph say about a file. */
export type FileKind = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface KindStyle {
  label: string;
  /** One-character glyph drawn on every tile: identity never rests on color alone. */
  glyph: string;
  /** Theme token the tile is tinted with. */
  token: string;
}

/**
 * Fixed order, fixed token per kind: a file keeps its color whatever else
 * changes. Green and red keep their diff meaning; the rest come from the
 * theme's chart and accent palette.
 */
export const KINDS: Record<FileKind, KindStyle> = {
  added: { label: "Added", glyph: "A", token: "--cadencr-acc-green" },
  modified: { label: "Modified", glyph: "M", token: "--cadencr-chart-4" },
  deleted: { label: "Deleted", glyph: "D", token: "--cadencr-acc-red" },
  untracked: { label: "Untracked", glyph: "U", token: "--cadencr-chart-5" },
  renamed: { label: "Renamed", glyph: "R", token: "--cadencr-acc-purple" },
  conflicted: { label: "Conflicted", glyph: "!", token: "--cadencr-acc-orange" },
};

export const KIND_ORDER: FileKind[] = [
  "added",
  "modified",
  "deleted",
  "untracked",
  "renamed",
  "conflicted",
];

/** The four kinds the legend always shows; the others appear when present. */
export const CORE_KINDS: FileKind[] = ["added", "modified", "deleted", "untracked"];

export interface FileNode {
  path: string;
  oldPath: string | null;
  name: string;
  dir: string;
  kind: FileKind;
  additions: number;
  deletions: number;
  staged: boolean;
  /** Tile area: changed lines, at least 1 so binary and empty files show. */
  weight: number;
}

export interface DirGroup {
  dir: string;
  files: FileNode[];
  weight: number;
  additions: number;
  deletions: number;
}

export interface Totals {
  files: number;
  additions: number;
  deletions: number;
  byKind: Record<FileKind, number>;
}

/** `status` is a git status code (`M`, `A`, `D`, `R100`, `UU`…); untracked
 *  files report `A` with `stage_state: "untracked"`. */
export function classify(file: ChangedFile): FileKind {
  if (file.stage_state === "untracked") return "untracked";
  if (file.stage_state === "conflicted" || file.conflict_kind) return "conflicted";
  switch (file.status.charAt(0)) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

export function toFileNode(file: ChangedFile): FileNode {
  const slash = file.file.lastIndexOf("/");
  return {
    path: file.file,
    oldPath: file.old_file ?? null,
    name: slash === -1 ? file.file : file.file.slice(slash + 1),
    dir: slash === -1 ? "" : file.file.slice(0, slash),
    kind: classify(file),
    additions: file.additions,
    deletions: file.deletions,
    staged: file.is_staged ?? false,
    weight: Math.max(1, file.additions + file.deletions),
  };
}

/** Files grouped by their directory, biggest groups and files first. */
export function groupByDirectory(files: FileNode[]): DirGroup[] {
  const groups = new Map<string, DirGroup>();
  for (const file of files) {
    let group = groups.get(file.dir);
    if (!group) {
      group = { dir: file.dir, files: [], weight: 0, additions: 0, deletions: 0 };
      groups.set(file.dir, group);
    }
    group.files.push(file);
    group.weight += file.weight;
    group.additions += file.additions;
    group.deletions += file.deletions;
  }
  const byWeight = <T extends { weight: number }>(a: T, b: T) => b.weight - a.weight;
  return [...groups.values()]
    .map((group) => ({ ...group, files: group.files.sort(byWeight) }))
    .sort(byWeight);
}

export function totalsOf(files: FileNode[]): Totals {
  const byKind = Object.fromEntries(KIND_ORDER.map((kind) => [kind, 0])) as Record<
    FileKind,
    number
  >;
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    byKind[file.kind] += 1;
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: files.length, additions, deletions, byKind };
}

export function dirLabel(dir: string): string {
  return dir === "" ? "(root)" : dir;
}

const NUMBER = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return NUMBER.format(value);
}
