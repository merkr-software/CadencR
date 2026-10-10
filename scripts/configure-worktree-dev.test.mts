import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnv as parseEnvText } from "node:util";
import {
  cloneOrCopy,
  configureWorktreeDev,
  FRESH_CLONE_MARKER,
  parseListeningPorts,
} from "./configure-worktree-dev.mts";

interface CheckoutOptions {
  withFiles?: boolean;
  withLegacyRootEnv?: boolean;
  withDatabase?: boolean;
  frontendPort?: number;
  servicePort?: number;
  remotePort?: number;
  profile?: string;
  dbPath?: string;
  serviceExtra?: string[];
}

function createCheckout(root: string, options: CheckoutOptions = {}): void {
  mkdirSync(join(root, "packages", "desktop"), { recursive: true });
  mkdirSync(join(root, "packages", "service"), { recursive: true });
  if (!options.withFiles) return;
  if (options.withLegacyRootEnv ?? true) {
    writeFileSync(join(root, ".env"), "CADENCR_AUTH_TOKEN=root-token\n");
  }
  writeFileSync(
    join(root, "packages", "desktop", ".env"),
    [
      "VITE_API_TOKEN=desktop-token",
      `VITE_FRONTEND_PORT=${options.frontendPort ?? 1420}`,
      `VITE_API_URL=http://127.0.0.1:${options.servicePort ?? 5005}`,
      options.profile ? `CADENCR_DEV_USER_DATA_SUFFIX=${options.profile}` : "",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "packages", "service", ".env"),
    [
      "CADENCR_AUTH_TOKEN=service-token",
      `CADENCR_FRONTEND_PORT=${options.frontendPort ?? 1420}`,
      `CADENCR_RUST_PORT=${options.servicePort ?? 5005}`,
      `CADENCR_DB_PATH=${options.dbPath ?? "./cadencr.local.db"}`,
      `CADENCR_REMOTE_PORT=${options.remotePort ?? 5007}`,
      ...(options.serviceExtra ?? []),
      "",
    ].join("\n"),
  );
  if (options.withDatabase ?? true) {
    writeFileSync(join(root, "packages", "service", "cadencr.local.db"), "base-database");
  }
}

function readEnv(filePath: string): Record<string, string | undefined> {
  return parseEnvText(readFileSync(filePath, "utf8"));
}

test("parses IPv4, IPv6, and wildcard listening ports", () => {
  assert.deepEqual(
    parseListeningPorts(
      ["p1", "n127.0.0.1:1420", "p2", "n[::1]:5005", "p3", "n*:6100", ""].join("\n"),
    ),
    new Set([1420, 5005, 6100]),
  );
});

test("copies dev files and allocates ports unused by worktrees or listeners", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-worktree-dev-"));
  const main = join(root, "main");
  const existing = join(root, "feature-existing");
  const current = join(root, "feature-current");
  createCheckout(main, { withFiles: true });
  createCheckout(existing, {
    withFiles: true,
    frontendPort: 1421,
    servicePort: 5100,
    remotePort: 6100,
    profile: "feature-existing",
  });
  createCheckout(current);
  const mainDesktopBefore = readFileSync(join(main, "packages", "desktop", ".env"), "utf8");
  const lockPath = join(root, "allocation.lock");

  try {
    const assignment = await configureWorktreeDev({
      currentRoot: current,
      mainRoot: main,
      worktreeRoots: [main, existing, current],
      lockPath,
      listeningPorts: new Set([1422]),
    });
    assert.deepEqual(assignment, {
      frontendPort: 1423,
      servicePort: 5101,
      remotePort: 6101,
      freshClone: true,
    });

    const desktop = readEnv(join(current, "packages", "desktop", ".env"));
    const service = readEnv(join(current, "packages", "service", ".env"));
    assert.equal(desktop.VITE_API_TOKEN, "desktop-token");
    assert.equal(desktop.VITE_FRONTEND_PORT, "1423");
    assert.equal(desktop.VITE_API_URL, "http://127.0.0.1:5101");
    assert.equal(desktop.CADENCR_DEV_USER_DATA_SUFFIX, "feature-current");
    assert.equal(service.CADENCR_AUTH_TOKEN, "service-token");
    assert.equal(service.CADENCR_FRONTEND_PORT, "1423");
    assert.equal(service.CADENCR_RUST_PORT, "5101");
    assert.equal(service.CADENCR_REMOTE_PORT, "6101");
    assert.equal(service.CADENCR_DEV_SKIP_DB_BACKUP, undefined);
    assert.match(readFileSync(join(current, FRESH_CLONE_MARKER), "utf8"), /first service start/);
    assert.equal(
      readFileSync(join(current, "packages", "service", "cadencr.local.db"), "utf8"),
      "base-database",
    );
    assert.equal(
      readFileSync(join(main, "packages", "desktop", ".env"), "utf8"),
      mainDesktopBefore,
    );
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reuses a worktree assignment and preserves its existing database", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-worktree-dev-"));
  const main = join(root, "main");
  const current = join(root, "feature-current");
  // The legacy skip flag, inherited from the main checkout, is dropped; and a
  // database that holds the worktree's own data never gets a marker.
  createCheckout(main, { withFiles: true, serviceExtra: ["CADENCR_DEV_SKIP_DB_BACKUP=1"] });
  createCheckout(current, {
    withFiles: true,
    frontendPort: 1450,
    servicePort: 5150,
    remotePort: 6150,
    profile: "feature-current",
  });
  writeFileSync(join(current, "packages", "service", "cadencr.local.db"), "worktree-state");
  rmSync(join(main, "packages", "service", "cadencr.local.db"));

  try {
    const assignment = await configureWorktreeDev({
      currentRoot: current,
      mainRoot: main,
      worktreeRoots: [main, current],
      lockPath: join(root, "allocation.lock"),
      listeningPorts: new Set([1450, 5150, 6150]),
    });
    assert.deepEqual(assignment, {
      frontendPort: 1450,
      servicePort: 5150,
      remotePort: 6150,
      freshClone: false,
    });
    assert.equal(
      readFileSync(join(current, "packages", "service", "cadencr.local.db"), "utf8"),
      "worktree-state",
    );
    const serviceEnv = readFileSync(join(current, "packages", "service", ".env"), "utf8");
    assert.doesNotMatch(serviceEnv, /CADENCR_DEV_SKIP_DB_BACKUP/);
    assert.equal(existsSync(join(current, FRESH_CLONE_MARKER)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps backups when CADENCR_DB_PATH names a database other than the clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-worktree-dev-"));
  const main = join(root, "main");
  const current = join(root, "feature-current");
  const shared = join(root, "shared.db");
  writeFileSync(shared, "shared-database");
  createCheckout(main, { withFiles: true, dbPath: shared });
  createCheckout(current);
  try {
    const { freshClone } = await configureWorktreeDev({
      currentRoot: current,
      mainRoot: main,
      worktreeRoots: [main, current],
      lockPath: join(root, "allocation.lock"),
      listeningPorts: new Set(),
    });
    assert.equal(freshClone, false);
    assert.equal(existsSync(join(current, FRESH_CLONE_MARKER)), false);
    const service = readEnv(join(current, "packages", "service", ".env"));
    assert.equal(service.CADENCR_DB_PATH, shared);
    assert.equal(service.CADENCR_DEV_SKIP_DB_BACKUP, undefined);
    assert.equal(readFileSync(shared, "utf8"), "shared-database");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to configure the main checkout", async () => {
  await assert.rejects(
    configureWorktreeDev({
      currentRoot: "/repo/main",
      mainRoot: "/repo/main",
      worktreeRoots: ["/repo/main"],
      lockPath: "/unused/lock",
      listeningPorts: new Set(),
    }),
    /linked worktree/,
  );
});

test("works from a fresh main checkout without a root .env or a dev database", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-worktree-dev-"));
  const main = join(root, "main");
  const current = join(root, "feature-current");
  createCheckout(main, { withFiles: true, withLegacyRootEnv: false, withDatabase: false });
  createCheckout(current);
  try {
    await configureWorktreeDev({
      currentRoot: current,
      mainRoot: main,
      worktreeRoots: [main, current],
      lockPath: join(root, "allocation.lock"),
      listeningPorts: new Set(),
    });
    assert.equal(
      readEnv(join(current, "packages", "service", ".env")).CADENCR_AUTH_TOKEN,
      "service-token",
    );
    assert.equal(existsSync(join(current, ".env")), false);
    assert.equal(existsSync(join(current, "packages", "service", "cadencr.local.db")), false);
    assert.equal(existsSync(join(current, FRESH_CLONE_MARKER)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneOrCopy reproduces the database bytes on every platform path", () => {
  const dir = mkdtempSync(join(tmpdir(), "cadencr-clone-"));
  try {
    const source = join(dir, "source.db");
    writeFileSync(source, "sqlite-bytes");
    for (const platform of [process.platform, "linux", "darwin"]) {
      const target = join(dir, `target-${platform}.db`);
      cloneOrCopy(source, target, platform);
      assert.equal(readFileSync(target, "utf8"), "sqlite-bytes");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cloneOrCopy reports a missing source instead of creating an empty file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cadencr-clone-"));
  try {
    const target = join(dir, "target.db");
    assert.throws(() => cloneOrCopy(join(dir, "missing.db"), target, "darwin"), /ENOENT/);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
