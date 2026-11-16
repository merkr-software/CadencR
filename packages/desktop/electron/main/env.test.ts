import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDevEnv } from "./env";

const keys = ["VITE_FRONTEND_PORT", "VITE_API_URL", "VITE_API_TOKEN"] as const;
const previous = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
  vi.restoreAllMocks();
});

function withEnvFile(contents: string): string {
  for (const key of keys) previous.set(key, process.env[key]);
  for (const key of keys) delete process.env[key];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadencr-env-"));
  fs.writeFileSync(path.join(dir, ".env"), contents, "utf8");
  return dir;
}

describe("loadDevEnv", () => {
  it("parses quoted values containing hash and equals characters", () => {
    const root = withEnvFile(
      [
        "VITE_FRONTEND_PORT=1420",
        "VITE_API_URL=http://127.0.0.1:5005",
        'VITE_API_TOKEN="abc#def=ghi"',
      ].join("\n"),
    );

    loadDevEnv(root);

    expect(process.env.VITE_API_TOKEN).toBe("abc#def=ghi");
  });

  it.skipIf(process.platform === "win32")(
    "does not mutate metadata when the env file is already private",
    () => {
      const root = withEnvFile(
        "VITE_FRONTEND_PORT=1420\nVITE_API_URL=http://127.0.0.1:5005\nVITE_API_TOKEN=secret\n",
      );
      const envPath = path.join(root, ".env");
      fs.chmodSync(envPath, 0o600);
      const chmod = vi.spyOn(fs, "fchmodSync");
      const before = fs.statSync(envPath);
      loadDevEnv(root);
      const after = fs.statSync(envPath);
      expect(chmod).not.toHaveBeenCalled();
      expect(after.ctimeMs).toBe(before.ctimeMs);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.ino).toBe(before.ino);
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens an existing env inode without replacing or rewriting its bytes",
    () => {
      const contents =
        "VITE_FRONTEND_PORT=1420\nVITE_API_URL=http://127.0.0.1:5005\nVITE_API_TOKEN=secret\n";
      const root = withEnvFile(contents);
      const envPath = path.join(root, ".env");
      fs.chmodSync(envPath, 0o644);
      const before = fs.statSync(envPath);
      loadDevEnv(root);
      const after = fs.statSync(envPath);
      expect(after.mode & 0o777).toBe(0o600);
      expect(after.ino).toBe(before.ino);
      expect(fs.readFileSync(envPath, "utf8")).toBe(contents);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlink and hardlink env files without changing their targets",
    () => {
      const root = withEnvFile("unused");
      const target = path.join(root, "target");
      const envPath = path.join(root, ".env");
      fs.writeFileSync(target, "secret");
      fs.chmodSync(target, 0o644);
      fs.unlinkSync(envPath);
      fs.symlinkSync(target, envPath);
      expect(() => loadDevEnv(root)).toThrow(/symbolic link/);
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);
      fs.unlinkSync(envPath);
      fs.linkSync(target, envPath);
      expect(() => loadDevEnv(root)).toThrow(/unshared file/);
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(target, "utf8")).toBe("secret");
    },
  );

  it("does not overwrite values already set in the process environment", () => {
    const root = withEnvFile(
      [
        "VITE_FRONTEND_PORT=1420",
        "VITE_API_URL=http://127.0.0.1:5005",
        "VITE_API_TOKEN=file-token",
      ].join("\n"),
    );
    process.env.VITE_API_TOKEN = "existing-token";

    loadDevEnv(root);

    expect(process.env.VITE_API_TOKEN).toBe("existing-token");
  });
});
