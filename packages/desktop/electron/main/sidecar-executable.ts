import fs from "node:fs";

export function ensureLinuxSidecarExecutable(binary: string, platform: NodeJS.Platform): void {
  if (platform !== "linux") return;

  // Package-managed installs may be root-owned; avoid chmod if +x is present.
  if (isExecutable(binary)) return;

  try {
    fs.chmodSync(binary, 0o755);
  } catch (error) {
    // Read-only packages can reject chmod even when the binary is executable.
    const code = errnoCode(error);
    if ((code === "EPERM" || code === "EROFS" || code === "EACCES") && isExecutable(binary)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to mark cadencr-service executable at ${binary}: ${message}`);
  }
}

function isExecutable(binary: string): boolean {
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
