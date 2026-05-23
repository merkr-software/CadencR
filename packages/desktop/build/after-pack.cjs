const { chmodSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === "linux") {
    makeLinuxSidecarExecutable(context);
    return;
  }

  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const sidecar = join(appPath, "Contents", "Resources", "cadencr-service");
  if (!existsSync(sidecar)) throw new Error(`Missing sidecar at ${sidecar}`);

  const identity = process.env.CADENCR_MAC_CODESIGN_IDENTITY || process.env.CSC_NAME || "-";
  const projectDir = context.packager.projectDir;
  sign(sidecar, identity, join(projectDir, "build", "entitlements.sidecar.mac.plist"));
};

function makeLinuxSidecarExecutable(context) {
  const sidecar = join(context.appOutDir, "resources", "cadencr-service");
  try {
    chmodSync(sidecar, 0o755);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to mark cadencr-service executable at ${sidecar}: ${message}`);
  }
}

function sign(target, identity, entitlements) {
  const timestampArgs = identity === "-" ? [] : ["--timestamp"];
  execFileSync(
    "codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      ...timestampArgs,
      "--sign",
      identity,
      target,
    ],
    { stdio: "inherit" },
  );
}
