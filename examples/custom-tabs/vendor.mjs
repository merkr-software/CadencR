#!/usr/bin/env node
// `npm run vendor` in an example folder: copies what Cadencr writes into every
// scaffolded tab and this repository keeps elsewhere, so the folder installs
// and builds on its own once copied out of the checkout:
//   vendor/*.tgz                       the SDK and kit tarballs
//   INSTRUCTION.md, AGENTS.md, CLAUDE.md the documents a coding agent reads first
// All of them are gitignored here. Run it again after `pnpm vendor:tab-packages`.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const vendorDir = join(repoRoot, "packages/service/resources/plugin-tabs/vendor");
const scaffoldDir = join(repoRoot, "packages/service/src/domain/plugin_tabs/scaffold");
const target = process.cwd();

const copies = [
  [join(vendorDir, "cadencr-tab-sdk.tgz"), "vendor/cadencr-tab-sdk.tgz"],
  [join(vendorDir, "cadencr-tab-kit.tgz"), "vendor/cadencr-tab-kit.tgz"],
  [join(scaffoldDir, "INSTRUCTION.md.tmpl"), "INSTRUCTION.md"],
  [join(scaffoldDir, "AGENTS.md.tmpl"), "AGENTS.md"],
  [join(scaffoldDir, "AGENTS.md.tmpl"), "CLAUDE.md"],
];

mkdirSync(join(target, "vendor"), { recursive: true });
for (const [from, to] of copies) {
  copyFileSync(from, join(target, to));
  console.log(`${to} ← ${from.slice(repoRoot.length + 1)}`);
}
