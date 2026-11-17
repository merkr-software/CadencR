// The Cargo workspace's members, read from the root manifest so that every
// crate added there runs the Rust checks without editing the hook.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The `members` of the root manifest's `[workspace]` table. Globs are refused
 * rather than expanded, so a new member can never silently skip the checks.
 */
export function parseWorkspaceMembers(manifest) {
  const workspace = manifest.split(/^\[/m).find((table) => table.startsWith("workspace]"));
  const list = workspace?.match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (list === undefined) throw new Error("Cargo.toml has no [workspace] members list");
  const members = [...list.replace(/#.*$/gm, "").matchAll(/["']([^"']+)["']/g)].map(([, member]) =>
    member.replace(/\/$/, ""),
  );
  const glob = members.find((member) => /[*?[]/.test(member));
  if (glob)
    throw new Error(`Cargo.toml workspace member "${glob}" is a glob; list members explicitly`);
  return members;
}

/** The workspace members of the checkout at `root`. */
export function workspaceMembers(root) {
  return parseWorkspaceMembers(readFileSync(join(root, "Cargo.toml"), "utf8"));
}
