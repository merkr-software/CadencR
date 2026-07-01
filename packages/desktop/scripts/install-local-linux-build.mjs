#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(scriptDir, "..");
const distDir = join(desktopDir, "dist-electron");

if (process.platform !== "linux") {
  console.log(`Skipping local Linux package install on ${process.platform}.`);
  process.exit(0);
}

assertDebianLikeLinux();

const debPath = findNewestDeb();

if (!debPath) {
  console.error(`No local Linux .deb artifact found in ${distDir}.`);
  process.exit(1);
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const command = isRoot ? "apt" : "sudo";
const args = isRoot
  ? ["install", "--reinstall", "-y", debPath]
  : ["apt", "install", "--reinstall", "-y", debPath];

console.log(`Installing local Linux build: ${debPath}`);

if (process.env.CADENCR_LOCAL_INSTALL_DRY_RUN === "1") {
  console.log([command, ...args].join(" "));
  process.exit(0);
}

const result = spawnSync(command, args, { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

function assertDebianLikeLinux() {
  let osRelease = "";
  try {
    osRelease = readFileSync("/etc/os-release", "utf8").toLowerCase();
  } catch {
    console.error("Cannot verify this Linux distro supports apt-based .deb installs.");
    process.exit(1);
  }

  if (!/(^|\n)(id|id_like)=.*(debian|ubuntu)/.test(osRelease)) {
    console.error("Local .deb install requires a Debian-like Linux distro with apt.");
    process.exit(1);
  }
}

function findNewestDeb() {
  let fileNames;
  try {
    fileNames = readdirSync(distDir);
  } catch {
    console.error(`Missing local build output directory: ${distDir}`);
    process.exit(1);
  }

  let newestPath;
  let newestMtime = Number.NEGATIVE_INFINITY;

  for (const fileName of fileNames) {
    if (!fileName.startsWith("Cadencr-") || !fileName.endsWith(".deb")) continue;

    const filePath = join(distDir, fileName);
    const mtime = statSync(filePath).mtimeMs;
    if (mtime > newestMtime) {
      newestPath = filePath;
      newestMtime = mtime;
    }
  }

  return newestPath;
}
