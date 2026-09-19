import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { buildArchive, collectStaging } from "../scripts/pack-provider/archive.mjs";

const script = fileURLToPath(new URL("../scripts/pack-provider.mjs", import.meta.url));

async function fixture({
  targetName = "darwin-aarch64",
  command = "bin/provider",
  executable = true,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pack-provider-"));
  const staging = path.join(root, "staging");
  await mkdir(path.join(staging, "bin"), { recursive: true });
  await mkdir(path.join(staging, "assets"));
  await writeFile(path.join(staging, command), "#!/bin/sh\necho provider\n");
  await chmod(path.join(staging, command), executable ? 0o755 : 0o644);
  await writeFile(path.join(staging, "assets/icon.svg"), "<svg/>\n");
  await writeFile(path.join(staging, "README.md"), "read me\n");
  await writeFile(path.join(staging, "LICENSE"), "license\n");
  const metadata = path.join(root, "package.json");
  await writeFile(
    metadata,
    JSON.stringify({
      agent: {
        id: "provider",
        name: "Provider",
        version: "1.0.0",
        description: "Test provider",
        distribution: {
          binary: {
            [targetName]: {
              archive: "https://example.invalid/provider.tar.gz",
              cmd: command,
              sha256: "0".repeat(64),
            },
          },
        },
      },
      host: {
        publisher: "publisher",
        compatibility: { min_app_version: "0.12.0" },
        assets: { icon: "assets/icon.svg", readme: "README.md", license: "LICENSE" },
      },
    }),
  );
  return { root, staging, metadata, targetName, command };
}

function run(input, output) {
  const { staging, metadata, targetName } = input;
  return spawnSync(
    process.execPath,
    [
      script,
      "--package",
      metadata,
      "--target",
      targetName,
      "--directory",
      staging,
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );
}

test("creates reproducible archives without changing the staging tree", async () => {
  const input = await fixture();
  const before = await Promise.all([
    readFile(path.join(input.staging, input.command)),
    lstat(path.join(input.staging, input.command)),
  ]);
  const first = run(input, path.join(input.root, "one.tar.gz"));
  const second = run(input, path.join(input.root, "two.tar.gz"));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    await readFile(path.join(input.root, "one.tar.gz")),
    await readFile(path.join(input.root, "two.tar.gz")),
  );
  const listing = spawnSync("tar", ["-tzf", path.join(input.root, "one.tar.gz")], {
    encoding: "utf8",
  });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split("\n"), [
    "LICENSE",
    "README.md",
    "assets/",
    "assets/icon.svg",
    "bin/",
    "bin/provider",
  ]);
  assert.equal(JSON.parse(first.stdout).sha256, JSON.parse(second.stdout).sha256);
  assert.deepEqual(await readFile(path.join(input.staging, input.command)), before[0]);
  assert.equal((await lstat(path.join(input.staging, input.command))).mode, before[1].mode);
});

test("leaves nullable asset acceptance to the shared metadata validator", async () => {
  const input = await fixture();
  const metadata = JSON.parse(await readFile(input.metadata, "utf8"));
  metadata.host.assets.readme = null;
  metadata.host.assets.license = null;
  await writeFile(input.metadata, JSON.stringify(metadata));
  await rm(path.join(input.staging, "README.md"));
  await rm(path.join(input.staging, "LICENSE"));
  const result = run(input, path.join(input.root, "out.tar.gz"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bounded relative package path/);
});

test("uses the declared target OS for executable policy", async () => {
  const windows = await fixture({
    targetName: "windows-x86_64",
    command: "bin/provider.exe",
    executable: false,
  });
  assert.equal(run(windows, path.join(windows.root, "windows.tar.gz")).status, 0);

  const linux = await fixture({ targetName: "linux-x86_64", executable: false });
  const result = run(linux, path.join(linux.root, "linux.tar.gz"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /entrypoint is not executable/);
});

test("rejects symlinks and secret-prone paths", async (context) => {
  await context.test("staging root symlink", async () => {
    const input = await fixture();
    const linked = path.join(input.root, "linked-staging");
    await symlink(input.staging, linked);
    input.staging = linked;
    const result = run(input, path.join(input.root, "out.tar.gz"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /staging directory must be a real directory/);
  });
  await context.test("symlink", async () => {
    const input = await fixture();
    await symlink("README.md", path.join(input.staging, "linked"));
    const result = run(input, path.join(input.root, "out.tar.gz"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symbolic links are forbidden/);
  });
  await context.test("secret", async () => {
    const input = await fixture();
    await writeFile(path.join(input.staging, ".env.production"), "TOKEN=x\n");
    const result = run(input, path.join(input.root, "out.tar.gz"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /secret-prone path is forbidden/);
  });
});

test("rejects non-portable and colliding path components", async (context) => {
  for (const name of ["CON", "bad?.txt", "trailing. "]) {
    await context.test(name, async () => {
      const input = await fixture();
      await writeFile(path.join(input.staging, name), "x");
      await assert.rejects(collectStaging(input.staging), /non-portable package path/);
    });
  }
  await context.test("case-fold collision", async () => {
    const input = await fixture();
    await writeFile(path.join(input.staging, "Case"), "x");
    await writeFile(path.join(input.staging, "case"), "x");
    const names = await import("node:fs/promises").then(({ readdir }) => readdir(input.staging));
    if (!names.includes("Case") || !names.includes("case")) return;
    await assert.rejects(collectStaging(input.staging), /portable path collision/);
  });
});

test("bounds a flat directory before sorting unbounded fanout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pack-provider-wide-"));
  await Promise.all(
    Array.from({ length: 4_097 }, (_, index) => writeFile(path.join(root, `f${index}`), "")),
  );
  await assert.rejects(collectStaging(root), /exceeds 4096 entries/);
});

test("rejects missing entrypoint and required assets", async (context) => {
  for (const [label, relative, expected] of [
    ["entrypoint", "bin/provider", /entrypoint is missing/],
    ["icon", "assets/icon.svg", /icon asset is missing/],
    ["readme", "README.md", /readme asset is missing/],
    ["license", "LICENSE", /license asset is missing/],
  ]) {
    await context.test(label, async () => {
      const input = await fixture();
      await rm(path.join(input.staging, relative));
      const result = run(input, path.join(input.root, "out.tar.gz"));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    });
  }
});

test("refuses overwrite and output within staging", async () => {
  const input = await fixture();
  const output = path.join(input.root, "out.tar.gz");
  await writeFile(output, "keep");
  const overwrite = run(input, output);
  assert.notEqual(overwrite.status, 0);
  assert.equal(await readFile(output, "utf8"), "keep");
  const nested = run(input, path.join(input.staging, "out.tar.gz"));
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /output must not be inside staging directory/);
});

test("rejects staging mutations and removes a failed output artifact", async (context) => {
  await context.test("growth", async () => {
    const input = await fixture();
    const collected = await collectStaging(input.staging);
    await writeFile(path.join(input.staging, input.command), "larger replacement payload\n");
    const output = path.join(input.root, "growth.tar.gz");
    await assert.rejects(buildArchive(collected.root, collected.entries, output), /changed/);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  });

  await context.test("symlink swap", async () => {
    const input = await fixture();
    const collected = await collectStaging(input.staging);
    await rm(path.join(input.staging, input.command));
    await symlink("../README.md", path.join(input.staging, input.command));
    const output = path.join(input.root, "swap.tar.gz");
    await assert.rejects(buildArchive(collected.root, collected.entries, output), /changed/);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  });

  await context.test("ancestor symlink swap", async () => {
    const input = await fixture();
    const collected = await collectStaging(input.staging);
    const replacement = path.join(input.root, "replacement-assets");
    await mkdir(replacement);
    await writeFile(path.join(replacement, "icon.svg"), "<svg/>\n");
    await rm(path.join(input.staging, "assets"), { recursive: true });
    await symlink(replacement, path.join(input.staging, "assets"));
    const output = path.join(input.root, "ancestor-swap.tar.gz");
    await assert.rejects(buildArchive(collected.root, collected.entries, output), /changed/);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  });

  await context.test("late addition", async () => {
    const input = await fixture();
    const collected = await collectStaging(input.staging);
    const output = path.join(input.root, "late.tar.gz");
    let added = false;
    const openDestination = async () => {
      const handle = await open(output, "wx", 0o644);
      return {
        stream: new Writable({
          write(_chunk, _encoding, callback) {
            if (!added) {
              added = true;
              writeFile(path.join(input.staging, "late.txt"), "late").then(() => callback());
            } else callback();
          },
        }),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    };
    await assert.rejects(
      buildArchive(collected.root, collected.entries, output, { openDestination }),
      /staging (?:tree|root) changed/,
    );
    await assert.rejects(lstat(output), { code: "ENOENT" });
  });

  await context.test("late removal", async () => {
    const input = await fixture();
    const collected = await collectStaging(input.staging);
    const output = path.join(input.root, "removed.tar.gz");
    let removed = false;
    const openDestination = async () => {
      const handle = await open(output, "wx", 0o644);
      return {
        stream: new Writable({
          write(_chunk, _encoding, callback) {
            if (!removed) {
              removed = true;
              rm(path.join(input.staging, "README.md")).then(() => callback());
            } else callback();
          },
        }),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    };
    await assert.rejects(
      buildArchive(collected.root, collected.entries, output, { openDestination }),
      /changed|ENOENT/,
    );
    await assert.rejects(lstat(output), { code: "ENOENT" });
  });
});

test("coordinates destination failure without hanging or leaking output", async () => {
  const input = await fixture();
  const collected = await collectStaging(input.staging);
  const output = path.join(input.root, "failure.tar.gz");
  const openDestination = async () => {
    const handle = await open(output, "wx", 0o644);
    return {
      stream: new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          callback(new Error("injected destination failure"));
        },
      }),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  };
  await assert.rejects(
    Promise.race([
      buildArchive(collected.root, collected.entries, output, { openDestination }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("packer hung")), 2_000)),
    ]),
    /injected destination failure/,
  );
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("reports both primary and cleanup failures", async () => {
  const input = await fixture();
  const collected = await collectStaging(input.staging);
  const output = path.join(input.root, "cleanup-failure.tar.gz");
  const openDestination = async () => {
    await writeFile(output, "partial");
    return {
      stream: new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error("primary write failure"));
        },
      }),
      sync: async () => {},
      close: async () => {
        throw new Error("injected close cleanup failure");
      },
    };
  };
  await assert.rejects(
    buildArchive(collected.root, collected.entries, output, { openDestination }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /primary write failure/);
      assert.match(error.message, /cleanup failed: injected close cleanup failure/);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  await assert.rejects(lstat(output), { code: "ENOENT" });
});
