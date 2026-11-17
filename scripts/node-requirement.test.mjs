import assert from "node:assert/strict";
import test from "node:test";
import { findInstalledNode, nodeInstallRoots, satisfiesRange } from "./node-requirement.mjs";

const REQUIREMENT = { range: ">=22.19.0 <23.0.0", nvmrc: "22.19.0" };

test("satisfiesRange handles the engines range and alternatives", () => {
  assert.ok(satisfiesRange("22.19.0", ">=22.19.0 <23.0.0"));
  assert.ok(satisfiesRange("v22.23.2", ">=22.19.0 <23.0.0"));
  assert.ok(!satisfiesRange("22.18.0", ">=22.19.0 <23.0.0"));
  assert.ok(!satisfiesRange("23.0.0", ">=22.19.0 <23.0.0"));
  assert.ok(satisfiesRange("20.1.0", ">=22 || 20.1.0"));
  assert.throws(() => satisfiesRange("22.0.0", "^22"), /unsupported/);
});

test("install roots cover fnm on macOS and Linux, nvm, volta, mise and asdf", () => {
  const roots = nodeInstallRoots({ env: {}, home: "/home/u" }).map(([dir, bin]) => `${dir}|${bin}`);
  assert.ok(roots.includes("/home/u/.local/share/fnm/node-versions|installation/bin"), "fnm (XDG)");
  assert.ok(
    roots.includes("/home/u/Library/Application Support/fnm/node-versions|installation/bin"),
  );
  assert.ok(roots.includes("/home/u/.nvm/versions/node|bin"));
  assert.ok(roots.includes("/home/u/.volta/tools/image/node|bin"));
  assert.ok(roots.includes("/home/u/.local/share/mise/installs/node|bin"));
  const custom = nodeInstallRoots({
    env: { FNM_DIR: "/opt/fnm", NVM_DIR: "/opt/nvm", XDG_DATA_HOME: "/data" },
    home: "/home/u",
  }).map(([dir]) => dir);
  assert.equal(custom[0], "/opt/fnm/node-versions");
  assert.ok(custom.includes("/data/fnm/node-versions"));
  assert.ok(custom.includes("/opt/nvm/versions/node"));
});

test("findInstalledNode prefers the exact .nvmrc version, then the newest in range", () => {
  const roots = [
    ["/fnm/node-versions", "installation/bin"],
    ["/nvm/versions/node", "bin"],
  ];
  const tree = {
    "/fnm/node-versions": ["v22.18.0", "v22.23.2", "v24.11.1", ".downloads"],
    "/nvm/versions/node": ["v22.19.0"],
  };
  const options = { roots, listDir: (dir) => tree[dir] ?? [], exists: () => true };
  assert.deepEqual(findInstalledNode(REQUIREMENT, options), {
    version: "22.19.0",
    binDir: "/nvm/versions/node/v22.19.0/bin",
  });

  delete tree["/nvm/versions/node"];
  assert.deepEqual(findInstalledNode(REQUIREMENT, options), {
    version: "22.23.2",
    binDir: "/fnm/node-versions/v22.23.2/installation/bin",
  });

  tree["/fnm/node-versions"] = ["v24.11.1", "v26.0.0"];
  assert.equal(findInstalledNode(REQUIREMENT, options), null, "never a Node outside the range");
});

test("findInstalledNode skips version directories without a node binary", () => {
  const found = findInstalledNode(REQUIREMENT, {
    roots: [["/fnm", "installation/bin"]],
    listDir: () => ["v22.19.0"],
    exists: () => false,
  });
  assert.equal(found, null);
});
