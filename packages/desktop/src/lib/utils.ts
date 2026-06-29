import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Shallow element-wise equality for two number arrays. */
export function intArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Shallow element-wise equality for two string arrays. */
export function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Strip the working-directory prefix from a string so paths display relative
 * to the workspace root.
 *
 * Handles both:
 *  - a path equal to or prefixed by `basePath` (e.g. `/cwd/src/foo.ts` → `src/foo.ts`)
 *  - free-form text that embeds the path (e.g. a Bash command or a Grep
 *    detail like `"pattern in /cwd/src/"`), where every occurrence of
 *    `basePath + "/"` is removed.
 *
 * Returns the input unchanged when `basePath` is undefined or absent.
 */
export function toRelativePath(text: string, basePath?: string): string {
  if (!basePath) return text;
  const prefix = basePath.endsWith("/") ? basePath : basePath + "/";
  if (text === basePath || text + "/" === prefix) return ".";
  return text.replaceAll(prefix, "");
}

/** Pretty-print a JSON string; return the input unchanged if it isn't JSON. */
export function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
