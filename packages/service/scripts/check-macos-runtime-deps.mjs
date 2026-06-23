import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const exe = process.platform === "win32" ? ".exe" : "";
const binaryPath = process.argv[2] || join("..", "desktop", "resources", "bin", `cadencr-service${exe}`);

if (process.platform !== "darwin") {
  console.log("Skipping macOS dylib check on non-darwin platform.");
  process.exit(0);
}

if (!existsSync(binaryPath)) {
  console.error(`Missing service binary: ${binaryPath}`);
  process.exit(1);
}

const result = spawnSync("otool", ["-L", binaryPath], {
  encoding: "utf8",
});

if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const forbiddenDeps = result.stdout
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("/opt/homebrew/") || line.startsWith("/usr/local/opt/"));

if (forbiddenDeps.length > 0) {
  console.error("Service binary must not depend on Homebrew dylibs:");
  for (const dependency of forbiddenDeps) {
    console.error(`- ${dependency}`);
  }
  process.exit(1);
}

console.log("Service binary has no Homebrew dylib dependencies.");
