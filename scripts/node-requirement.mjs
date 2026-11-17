// The Node the checks run on: `engines.node` in package.json, pinned exactly by
// .nvmrc. Node ≥ 25 ships its own `localStorage` global, which shadows the DOM
// test environments' and fails dozens of desktop tests, so the checks must
// never pick up whichever Node comes first on a modified PATH (Homebrew's, for
// one). `pnpm doctor` and scripts/toolchain-env.mjs share these helpers.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const parseVersion = (value) => value.replace(/^v/, "").split(".").map(Number);

function compare(a, b) {
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

/** Minimal semver range check: space-joined comparators, `||` alternatives. */
export function satisfiesRange(version, range) {
  const actual = parseVersion(version);
  return range.split("||").some((set) =>
    set
      .trim()
      .split(/\s+/)
      .every((comparator) => {
        const [, op = "=", target] =
          comparator.match(/^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/) ?? [];
        if (!target) throw new Error(`unsupported version comparator: ${comparator}`);
        const order = compare(actual, parseVersion(target));
        return {
          ">=": order >= 0,
          "<=": order <= 0,
          ">": order > 0,
          "<": order < 0,
          "=": order === 0,
        }[op];
      }),
  );
}

/** `engines.node` and the .nvmrc pin of the checkout at `root`. */
export function nodeRequirement(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    range: pkg.engines.node,
    nvmrc: readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/, ""),
  };
}

/**
 * Where version managers keep Node installs: `[versionsDir, binOf(version)]`.
 * fnm and nvm name version directories `v22.19.0`; volta, mise and asdf `22.19.0`.
 */
export function nodeInstallRoots({ env = process.env, home = homedir() } = {}) {
  const xdgData = xdgDataHome(env, home);
  const fnmDirs = [
    env.FNM_DIR,
    join(xdgData, "fnm"),
    join(home, "Library/Application Support/fnm"),
    join(home, ".fnm"),
  ].filter(Boolean);
  return [
    ...fnmDirs.map((dir) => [join(dir, "node-versions"), "installation/bin"]),
    [join(env.NVM_DIR || join(home, ".nvm"), "versions/node"), "bin"],
    [join(env.VOLTA_HOME || join(home, ".volta"), "tools/image/node"), "bin"],
    [join(xdgData, "mise/installs/node"), "bin"],
    [join(env.ASDF_DATA_DIR || join(home, ".asdf"), "installs/nodejs"), "bin"],
  ];
}

/**
 * The installed Node to run the checks with when the current one is outside
 * `range`: the exact .nvmrc version if installed, else the newest that
 * satisfies the range. Returns the `bin` directory holding `node`, or null.
 */
export function findInstalledNode(
  { range, nvmrc },
  { roots = nodeInstallRoots(), listDir = listDirOrEmpty, exists = existsSync } = {},
) {
  const installs = [];
  for (const [versionsDir, bin] of roots) {
    for (const name of listDir(versionsDir)) {
      const version = name.replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+$/.test(version) || !satisfiesRange(version, range)) continue;
      const binDir = join(versionsDir, name, bin);
      if (exists(join(binDir, "node"))) installs.push({ version, binDir });
    }
  }
  const exact = installs.find(({ version }) => version === nvmrc);
  if (exact) return exact;
  installs.sort((a, b) => compare(parseVersion(b.version), parseVersion(a.version)));
  return installs[0] ?? null;
}

/** `$XDG_DATA_HOME`, or its default. */
export function xdgDataHome(env, home) {
  return env.XDG_DATA_HOME || join(home, ".local/share");
}

/** A directory's entry names, or none when it is missing or unreadable. */
export function listDirOrEmpty(dir) {
  try {
    return readdirSync(dir);
  } catch {
    // A tool that is not installed has no directory: nothing to offer there.
    return [];
  }
}
