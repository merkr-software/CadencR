import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const FULL_SIGN_IDENTITY =
  process.env.CADENCR_MAC_SIGN_IDENTITY ??
  "Developer ID Application: Raphael Le Minor (64R5HXD8YU)";
const ELECTRON_BUILDER_SIGN_IDENTITY = removeDeveloperIdPrefix(FULL_SIGN_IDENTITY);
const NOTARY_PROFILE =
  process.env.APPLE_NOTARIZE_PROFILE ?? process.env.CADENCR_NOTARY_PROFILE ?? "cadencr-notary";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(scriptDir, "..");
const distDir = join(desktopDir, "dist-electron");

main();

function main() {
  assertMacOS();
  assertCommand("xcrun", ["--find", "notarytool"]);
  assertCommand("xcrun", ["--find", "stapler"]);
  assertSigningIdentity(FULL_SIGN_IDENTITY);
  assertNotaryProfile(NOTARY_PROFILE);

  console.log(`Using codesign identity: ${FULL_SIGN_IDENTITY}`);
  console.log(`Using Electron Builder identity: ${ELECTRON_BUILDER_SIGN_IDENTITY}`);
  console.log(`Using notary profile: ${NOTARY_PROFILE}`);

  rmSync(distDir, { force: true, recursive: true });

  const env = {
    ...process.env,
    APPLE_NOTARIZE_PROFILE: NOTARY_PROFILE,
    CADENCR_NOTARIZE: "true",
    CADENCR_NOTARY_PROFILE: NOTARY_PROFILE,
    CADENCR_MAC_CODESIGN_IDENTITY: FULL_SIGN_IDENTITY,
    CSC_NAME: ELECTRON_BUILDER_SIGN_IDENTITY,
  };

  run("pnpm", ["--filter", "@cadencr/service", "build:macos-sidecars"], { cwd: desktopDir, env });
  run("node", ["scripts/electron-vite.mjs", "build"], { cwd: desktopDir, env });
  run("pnpm", ["exec", "electron-builder", "--config", "electron-builder.yml"], {
    cwd: desktopDir,
    env,
  });
  run("node", ["scripts/notarize-artifacts.mjs"], { cwd: desktopDir, env });
}

function removeDeveloperIdPrefix(identity) {
  return identity.replace(/^Developer ID Application:\s*/, "");
}

function assertMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("Signed macOS builds must be produced on macOS.");
  }
}

function assertCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Required command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
  }
}

function assertSigningIdentity(identity) {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Unable to list signing identities.\n${result.stderr}`);
  }
  if (!result.stdout.includes(identity)) {
    throw new Error(`Missing signing identity in Keychain: ${identity}\n${result.stdout}`);
  }
}

function assertNotaryProfile(profile) {
  const result = spawnSync("xcrun", ["notarytool", "history", "--keychain-profile", profile], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Invalid notarytool profile: ${profile}\n${result.stderr}`);
  }
}

function run(command, args, options) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${command} ${args.join(" ")}`);
  }
}
