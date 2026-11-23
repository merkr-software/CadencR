import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceMembers, workspaceMembers } from "./cargo-workspace.mjs";

test("workspace members are read from [workspace] and globs are refused", () => {
  const manifest = `[package]
name = "x"
members = ["not/this"]

[workspace]
members = [
    "packages/a", # trailing comment
    'packages/b-rs',
]
resolver = "2"
`;
  assert.deepEqual(parseWorkspaceMembers(manifest), ["packages/a", "packages/b-rs"]);
  assert.throws(() => parseWorkspaceMembers('[workspace]\nmembers = ["packages/*"]\n'), /glob/);
  assert.throws(() => parseWorkspaceMembers("[package]\nname = 'x'\n"), /no \[workspace\] members/);
});

test("the repository's own members are explicit paths", () => {
  const members = workspaceMembers(new URL("..", import.meta.url).pathname);
  assert.ok(members.includes("packages/service"));
  assert.ok(members.includes("packages/registry-publisher"));
});
