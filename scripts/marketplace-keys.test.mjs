import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./marketplace-keys.sh", import.meta.url));
const REAL_CADENCR = fileURLToPath(new URL("../target/debug/cadencr", import.meta.url));
const roots = [];
const mode = (file) => (statSync(file).mode & 0o777).toString(8);
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function findOpenssl() {
  for (const candidate of [
    process.env.OPENSSL_BIN,
    "openssl",
    "/opt/homebrew/opt/openssl@3/bin/openssl",
  ]) {
    if (!candidate) continue;
    const listed = spawnSync(candidate, ["list", "-public-key-algorithms"], { encoding: "utf8" });
    if (listed.status === 0 && /ed25519/i.test(listed.stdout)) return candidate;
  }
  return null;
}
const OPENSSL = findOpenssl();
const skipNoOpenssl = OPENSSL ? false : "no openssl with Ed25519 support";

const NODE_FAKE_PRELUDE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const state = process.env.FAKE_STATE;
const args = process.argv.slice(2);
const log = (extra) => fs.appendFileSync(path.join(state, "calls.log"), JSON.stringify({ bin: path.basename(process.argv[1]), argv: args, ...extra }) + "\\n");
const dir = (name) => { const target = path.join(state, name); fs.mkdirSync(target, { recursive: true }); return target; };
const flag = (name) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
`;

const FAKES = {
  security: `
if (args[0] === "-i") {
  log({ stdin: "commands" });
  const input = fs.readFileSync(0, "utf8");
  if (process.env.FAKE_SECURITY_FAIL) process.exit(1);
  for (const line of input.split("\\n").filter(Boolean)) {
    const m = /^add-generic-password -s "([^"]*)" -a "([^"]*)" -w "([^"]*)"(?: "([^"]*)")?$/.exec(line);
    if (!m) { console.error("fake security: bad command"); process.exit(1); }
    fs.writeFileSync(path.join(dir("kc"), m[1] + "__" + m[2]), process.env.FAKE_KC_CORRUPT ? m[3] + "A" : m[3]);
  }
  process.exit(0);
}
if (args[0] === "find-generic-password") {
  log();
  const file = path.join(dir("kc"), flag("-s") + "__" + flag("-a"));
  if (!fs.existsSync(file)) { console.error("The specified item could not be found in the keychain."); process.exit(44); }
  if (args.includes("-w")) process.stdout.write(fs.readFileSync(file, "utf8") + "\\n");
  process.exit(0);
}
log(); process.exit(2);
`,
  op: `
if (args[0] === "item" && args[1] === "create") {
  log({ stdin: "template" });
  const input = fs.readFileSync(0, "utf8");
  if (process.env.FAKE_OP_FAIL_CREATE) { console.error("op: create failed"); process.exit(1); }
  const item = JSON.parse(input);
  const value = item.fields.find((field) => field.id === "notesPlain").value;
  fs.writeFileSync(path.join(dir("op"), item.title), value);
  fs.writeFileSync(path.join(dir("op"), item.title + ".meta"), JSON.stringify({ vault: flag("--vault"), category: item.category }));
  process.exit(0);
}
if (args[0] === "item" && args[1] === "get") {
  log();
  const file = path.join(dir("op"), args[2]);
  if (!fs.existsSync(file)) { console.error("op: isn't an item"); process.exit(1); }
  if (args.includes("--fields")) process.stdout.write(fs.readFileSync(file, "utf8") + "\\n");
  else process.stdout.write("title: " + args[2] + "\\n");
  process.exit(0);
}
log(); process.exit(2);
`,
  gh: `
if (args[0] === "secret" && args[1] === "set") {
  log({ stdin: "secret" });
  const body = fs.readFileSync(0, "utf8");
  if (process.env.FAKE_GH_FAIL_ENV === flag("--env")) { console.error("gh: HTTP 403"); process.exit(1); }
  fs.writeFileSync(path.join(dir("gh"), flag("--env") + "__" + args[2]), body);
  process.exit(0);
}
log(); process.exit(2);
`,
  cadencr: `
if (args[0] !== "registry") { log(); process.exit(2); }
if (args[1] === "sign-trust-manifest") {
  const keyFile = flag("--root-private-key");
  const stat = fs.statSync(keyFile);
  const parent = fs.statSync(path.dirname(keyFile));
  const key = fs.readFileSync(keyFile, "utf8");
  fs.appendFileSync(path.join(state, "keypaths"), keyFile + "\\n");
  log({ keyMode: (stat.mode & 0o777).toString(8), dirMode: (parent.mode & 0o777).toString(8), keyIsPem: key.startsWith("-----BEGIN PRIVATE KEY-----") });
  if (process.env.FAKE_SIGN_HANG) {
    fs.writeFileSync(path.join(state, "hang.pid"), String(process.pid));
    setTimeout(() => {}, 60000);
    return;
  }
  if (process.env.FAKE_SIGN_FAIL) { console.error("sign failed"); process.exit(1); }
  fs.writeFileSync(flag("--output"), '{"signed":"fake"}\\n');
  console.log("wrote signed trust manifest");
  process.exit(0);
}
if (args[1] === "verify-trust-manifest") {
  log({ manifestExists: fs.existsSync(flag("--manifest")), rootPemExists: fs.existsSync(path.join(path.dirname(flag("--manifest")), "root.pem")) });
  if (process.env.FAKE_VERIFY_FAIL) { console.error("verification failed"); process.exit(1); }
  console.log("valid registry trust generation 1");
  process.exit(0);
}
log(); process.exit(2);
`,
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "marketplace-keys-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const tmp = join(root, "tmp");
  for (const dir of [bin, state, tmp]) mkdirSync(dir);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: tmp,
    FAKE_STATE: state,
    CADENCR_KEYS_ALLOW_NON_DARWIN: "1",
  };
  if (OPENSSL) env.OPENSSL_BIN = OPENSSL;
  for (const [name, body] of Object.entries(FAKES)) {
    const path = join(bin, name);
    writeFileSync(path, NODE_FAKE_PRELUDE + body);
    chmodSync(path, 0o755);
    env[{ security: "SECURITY_BIN", op: "OP_BIN", gh: "GH_BIN", cadencr: "CADENCR_BIN" }[name]] =
      path;
  }
  const calls = () => {
    const file = join(state, "calls.log");
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  };
  const run = (args, extraEnv = {}) =>
    spawnSync("bash", [SCRIPT, ...args], {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 60_000,
    });
  return { root, bin, state, tmp, env, calls, run };
}

const stored = (ctx, kind, name) => readFileSync(join(ctx.state, kind, name), "utf8");
const pemOf = (b64) => Buffer.from(b64, "base64").toString("utf8");
function rawPublicB64(pem) {
  const spki = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
  return spki.subarray(-32).toString("base64");
}
/** Every string that would reveal the private key if it showed up somewhere it must not. */
function secretsOf(pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return [body, Buffer.from(pem).toString("base64")];
}
function assertNoLeak(ctx, result, pem) {
  const haystacks = [
    result.stdout,
    result.stderr,
    readFileSync(join(ctx.state, "calls.log"), "utf8"),
  ];
  for (const secret of secretsOf(pem)) {
    for (const haystack of haystacks) assert.ok(!haystack.includes(secret), "private key leaked");
  }
  for (const call of ctx.calls()) {
    assert.ok(!JSON.stringify(call.argv).includes("PRIVATE KEY"));
  }
}
const assertTmpEmpty = (ctx) => assert.deepEqual(readdirSync(ctx.tmp), []);

function seedRoot(ctx, keyId = "root-1", vault = "Vault") {
  const result = ctx.run(["generate-root", "--key-id", keyId, "--vault", vault]);
  assert.equal(result.status, 0, result.stderr);
  const b64 = stored(ctx, "kc", `cadencr-marketplace-root__${keyId}`);
  writeFileSync(
    join(ctx.root, "root-pub.pem"),
    createPublicKey(createPrivateKey(pemOf(b64))).export({ type: "spki", format: "pem" }),
  );
  return { b64, pem: pemOf(b64), publicB64: rawPublicB64(pemOf(b64)), result };
}

test(
  "generate-root stores one identical copy in Keychain and 1Password and prints only public data",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const { b64, pem, publicB64, result } = seedRoot(ctx);
    assert.equal(stored(ctx, "op", "cadencr-marketplace-root-root-1"), b64);
    assert.deepEqual(JSON.parse(stored(ctx, "op", "cadencr-marketplace-root-root-1.meta")), {
      vault: "Vault",
      category: "SECURE_NOTE",
    });
    assert.match(result.stdout, /root key id: root-1/);
    assert.ok(result.stdout.includes(`root public key (base64, raw 32 bytes): ${publicB64}`));
    assert.match(result.stdout, /BEGIN PUBLIC KEY/);
    assert.ok(!result.stdout.includes("PRIVATE"));
    assertNoLeak(ctx, result, pem);
    assertTmpEmpty(ctx);
    const writes = ctx.calls().filter((call) => call.stdin);
    assert.deepEqual(
      writes.map((call) => call.bin),
      ["op", "security"],
    );
  },
);

test(
  "generate-root can also write the public PEM and refuses to overwrite it",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const out = join(ctx.root, "root-public.pem");
    const first = ctx.run([
      "generate-root",
      "--key-id",
      "r",
      "--vault",
      "V",
      "--public-pem-out",
      out,
    ]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(out, "utf8"), /BEGIN PUBLIC KEY/);
    const second = ctx.run([
      "generate-root",
      "--key-id",
      "r2",
      "--vault",
      "V",
      "--public-pem-out",
      out,
    ]);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refusing to overwrite/);
  },
);

test(
  "generate-root refuses existing stores and cleans up on every failure",
  { skip: skipNoOpenssl },
  () => {
    const first = setup();
    seedRoot(first);
    const again = first.run(["generate-root", "--key-id", "root-1", "--vault", "Vault"]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);

    const opOnly = setup();
    mkdirSync(join(opOnly.state, "op"));
    writeFileSync(join(opOnly.state, "op", "cadencr-marketplace-root-r"), "x");
    assert.match(
      opOnly.run(["generate-root", "--key-id", "r", "--vault", "V"]).stderr,
      /1Password item .* already exists/,
    );

    for (const [fail, pattern, writtenKeychain] of [
      [{ FAKE_OP_FAIL_CREATE: "1" }, /1Password write failed/, false],
      [{ FAKE_SECURITY_FAIL: "1" }, /Keychain write failed/, false],
      [{ FAKE_KC_CORRUPT: "1" }, /read-back mismatch/, true],
    ]) {
      const ctx = setup();
      const result = ctx.run(["generate-root", "--key-id", "r", "--vault", "V"], fail);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
      assert.ok(!result.stdout.includes("public key"), "no key reported after a failed store");
      assert.equal(
        existsSync(join(ctx.state, "kc", "cadencr-marketplace-root__r")),
        writtenKeychain,
      );
      assertTmpEmpty(ctx);
      const opItem = join(ctx.state, "op", "cadencr-marketplace-root-r");
      if (existsSync(opItem)) assertNoLeak(ctx, result, pemOf(readFileSync(opItem, "utf8")));
    }
  },
);

test(
  "generate-online pipes the key to each environment secret via stdin and prints only the public key",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const result = ctx.run([
      "generate-online",
      "--key-id",
      "online-1",
      "--repo",
      "acme/registry",
      "--env",
      "publication",
      "--env",
      "renewal",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const secrets = ["publication", "renewal"].map((env) =>
      stored(ctx, "gh", `${env}__CADENCR_REGISTRY_PRIVATE_KEY_PEM`),
    );
    assert.equal(secrets[0], secrets[1]);
    assert.match(secrets[0], /^-----BEGIN PRIVATE KEY-----/);
    assert.ok(result.stdout.includes(rawPublicB64(secrets[0])));
    const gh = ctx.calls().filter((call) => call.bin === "gh");
    assert.deepEqual(
      gh.map((call) => call.argv),
      [
        [
          "secret",
          "set",
          "CADENCR_REGISTRY_PRIVATE_KEY_PEM",
          "--env",
          "publication",
          "--repo",
          "acme/registry",
        ],
        [
          "secret",
          "set",
          "CADENCR_REGISTRY_PRIVATE_KEY_PEM",
          "--env",
          "renewal",
          "--repo",
          "acme/registry",
        ],
      ],
    );
    assertNoLeak(ctx, result, secrets[0]);
    assertTmpEmpty(ctx);
  },
);

test(
  "generate-online reports a failed upload, keeps nothing locally and prints no key",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const result = ctx.run(
      [
        "generate-online",
        "--key-id",
        "o",
        "--repo",
        "acme/registry",
        "--env",
        "publication",
        "--env",
        "renewal",
      ],
      { FAKE_GH_FAIL_ENV: "renewal" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /environment 'renewal'.*uploaded: publication/);
    assert.ok(!result.stdout.includes("public key"));
    assertTmpEmpty(ctx);
    assertNoLeak(ctx, result, stored(ctx, "gh", "publication__CADENCR_REGISTRY_PRIVATE_KEY_PEM"));
    assert.notEqual(
      ctx.run(["generate-online", "--key-id", "o", "--repo", "acme/registry"]).status,
      0,
      "needs --env",
    );
    assert.notEqual(
      ctx.run(["generate-online", "--key-id", "o", "--repo", "not-a-repo", "--env", "e"]).status,
      0,
    );
  },
);

function signArgs(ctx, extra = []) {
  writeFileSync(join(ctx.root, "payload.json"), '{"kind":"registry-trust"}');
  return [
    "sign-trust",
    "--payload",
    join(ctx.root, "payload.json"),
    "--output",
    join(ctx.root, "signed-trust.json"),
    "--key-id",
    "root-1",
    "--root-public-key",
    join(ctx.root, "root-pub.pem"),
    ...extra,
  ];
}

test(
  "sign-trust signs from a 0600 key in a 0700 dir, verifies, wipes, and writes only a verified manifest",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const { pem } = seedRoot(ctx);
    const result = ctx.run(signArgs(ctx, ["--minimum-generation", "3"]));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(ctx.root, "signed-trust.json"), "utf8"), '{"signed":"fake"}\n');
    const cadencr = ctx.calls().filter((call) => call.bin === "cadencr");
    assert.deepEqual(
      cadencr.map((call) => call.argv[1]),
      ["sign-trust-manifest", "verify-trust-manifest"],
    );
    assert.equal(cadencr[0].keyMode, "600");
    assert.equal(cadencr[0].dirMode, "700");
    assert.ok(cadencr[0].keyIsPem);
    const verifyArgs = cadencr[1].argv;
    assert.equal(verifyArgs[verifyArgs.indexOf("--minimum-generation") + 1], "3");
    assert.equal(verifyArgs[verifyArgs.indexOf("--root-key-id") + 1], "root-1");
    assert.equal(
      verifyArgs[verifyArgs.indexOf("--root-public-key") + 1],
      join(ctx.root, "root-pub.pem"),
    );
    assert.ok(cadencr[1].manifestExists);
    for (const keyPath of readFileSync(join(ctx.state, "keypaths"), "utf8").trim().split("\n")) {
      assert.ok(!existsSync(keyPath), "temp key must be gone");
    }
    assertNoLeak(ctx, result, pem);
    assertTmpEmpty(ctx);
  },
);

test(
  "sign-trust leaves no output and no temp files when signing or verification fails",
  { skip: skipNoOpenssl },
  () => {
    for (const [fail, pattern] of [
      [{ FAKE_SIGN_FAIL: "1" }, /signing failed/],
      [{ FAKE_VERIFY_FAIL: "1" }, /did not verify/],
    ]) {
      const ctx = setup();
      const { pem } = seedRoot(ctx);
      const result = ctx.run(signArgs(ctx), fail);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
      assert.ok(!existsSync(join(ctx.root, "signed-trust.json")));
      assertNoLeak(ctx, result, pem);
      assertTmpEmpty(ctx);
    }
  },
);

test(
  "sign-trust refuses missing or unsafe inputs before touching the Keychain",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    seedRoot(ctx);
    const base = signArgs(ctx);
    const without = (flag) => {
      const copy = [...base];
      copy.splice(copy.indexOf(flag), 2);
      return copy;
    };
    const before = ctx.calls().length;
    for (const flag of ["--payload", "--output", "--key-id", "--root-public-key"]) {
      const result = ctx.run(without(flag));
      assert.notEqual(result.status, 0, flag);
      assert.match(result.stderr, /missing required option/);
    }
    const missingFile = (flag, name) => {
      const copy = [...base];
      copy[copy.indexOf(flag) + 1] = join(ctx.root, name);
      return ctx.run(copy);
    };
    assert.match(missingFile("--payload", "nope.json").stderr, /payload not found/);
    assert.match(missingFile("--root-public-key", "nope.pem").stderr, /root public key not found/);
    assert.match(ctx.run([...base, "--minimum-generation", "0"]).stderr, /positive integer/);
    assert.match(
      ctx.run(base.map((arg) => (arg === "root-1" ? "../x" : arg))).stderr,
      /must match/,
    );
    writeFileSync(join(ctx.root, "signed-trust.json"), "existing");
    assert.match(ctx.run(base).stderr, /output exists/);
    assert.equal(readFileSync(join(ctx.root, "signed-trust.json"), "utf8"), "existing");
    assert.equal(ctx.calls().length, before, "no external tool ran for rejected input");

    const missingKey = ctx.run(
      signArgs(ctx)
        .map((arg) => (arg === "root-1" ? "other-root" : arg))
        .concat("--force"),
    );
    assert.notEqual(missingKey.status, 0);
    assert.match(missingKey.stderr, /no Keychain item/);
    assert.ok(!ctx.calls().some((call) => call.bin === "cadencr"));
    assertTmpEmpty(ctx);
  },
);

test(
  "a TERM during signing wipes the temp key before exiting",
  { skip: skipNoOpenssl },
  async () => {
    const ctx = setup();
    seedRoot(ctx);
    const args = signArgs(ctx);
    const child = spawn("bash", [SCRIPT, ...args], {
      env: { ...ctx.env, FAKE_SIGN_HANG: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const pidFile = join(ctx.state, "hang.pid");
    for (let i = 0; i < 200 && !existsSync(pidFile); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(pidFile), "fake CLI never started: " + stderr);
    assert.ok(readdirSync(ctx.tmp).length > 0, "temp dir exists while signing");
    const exited = new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    // A terminal Ctrl-C/TERM reaches the whole foreground group; bash runs its trap once the child is gone.
    child.kill("SIGTERM");
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    const { code } = await exited;
    assert.equal(code, 143);
    assertTmpEmpty(ctx);
    assert.ok(!existsSync(join(ctx.root, "signed-trust.json")));
  },
);

test(
  "verify-backup confirms identical copies and the expected public key without printing them",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const { pem, publicB64 } = seedRoot(ctx);
    const args = ["verify-backup", "--key-id", "root-1", "--vault", "Vault"];
    for (const expected of [
      ["--expected-public-key", join(ctx.root, "root-pub.pem")],
      ["--expected-public-key-base64", publicB64],
    ]) {
      const result = ctx.run([...args, ...expected]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /copies: identical/);
      assert.match(result.stdout, /public key: matches expected/);
      assertNoLeak(ctx, result, pem);
      assertTmpEmpty(ctx);
    }
    const wrong = ctx.run([
      ...args,
      "--expected-public-key-base64",
      Buffer.alloc(32, 7).toString("base64"),
    ]);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /does not match the expected public key/);
    assert.notEqual(ctx.run(args).status, 0, "an expected public key is mandatory");
    assertTmpEmpty(ctx);
  },
);

test(
  "verify-backup fails when the two copies differ or one is missing",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const { pem, publicB64 } = seedRoot(ctx);
    const args = [
      "verify-backup",
      "--key-id",
      "root-1",
      "--vault",
      "Vault",
      "--expected-public-key-base64",
      publicB64,
    ];
    writeFileSync(
      join(ctx.state, "op", "cadencr-marketplace-root-root-1"),
      stored(ctx, "op", "cadencr-marketplace-root-root-1") + "A",
    );
    const differing = ctx.run(args);
    assert.notEqual(differing.status, 0);
    assert.match(differing.stderr, /DIFFER/);
    assertNoLeak(ctx, differing, pem);
    rmSync(join(ctx.state, "op", "cadencr-marketplace-root-root-1"));
    const missing = ctx.run(args);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /cannot read 1Password item/);
    assertTmpEmpty(ctx);
  },
);

/** A `dd` wrapper that records, per overwrite, the target and a checksum of its content before and after. */
function installDdSpy(ctx) {
  const dd = join(ctx.bin, "dd");
  writeFileSync(
    dd,
    `#!/bin/sh
for a in "$@"; do case "$a" in of=*) f=\${a#of=} ;; esac; done
before=$(cksum <"$f")
/bin/dd "$@"; rc=$?
echo "$f|$before|$(cksum <"$f")" >>"$FAKE_STATE/dd.log"
exit $rc
`,
  );
  chmodSync(dd, 0o755);
  return { PATH: `${ctx.bin}:${process.env.PATH}` };
}

test(
  "sign-trust overwrites root.pem with random bytes before removing it, before verification runs",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    seedRoot(ctx);
    const spyEnv = installDdSpy(ctx);
    const result = ctx.run(signArgs(ctx), spyEnv);
    assert.equal(result.status, 0, result.stderr);
    const entries = readFileSync(join(ctx.state, "dd.log"), "utf8").trim().split("\n");
    const rootEntries = entries.filter((line) => line.split("|")[0].endsWith("/root.pem"));
    assert.equal(rootEntries.length, 1, "root.pem is overwritten exactly once, by the early wipe");
    const [, before, after] = rootEntries[0].split("|");
    assert.notEqual(before, after, "content must actually be overwritten");
    const verify = ctx.calls().find((call) => call.argv[1] === "verify-trust-manifest");
    assert.equal(verify.rootPemExists, false, "root.pem is gone before verification starts");
    assertTmpEmpty(ctx);
  },
);

test(
  "public outputs are 0644 while private temp material stays 0600",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const out = join(ctx.root, "root-public.pem");
    const root = ctx.run([
      "generate-root",
      "--key-id",
      "root-1",
      "--vault",
      "V",
      "--public-pem-out",
      out,
    ]);
    assert.equal(root.status, 0, root.stderr);
    assert.equal(mode(out), "644");
    writeFileSync(
      join(ctx.root, "root-pub.pem"),
      createPublicKey(
        createPrivateKey(pemOf(stored(ctx, "kc", "cadencr-marketplace-root__root-1"))),
      ).export({ type: "spki", format: "pem" }),
    );
    const online = join(ctx.root, "online-public.pem");
    const gen = ctx.run([
      "generate-online",
      "--key-id",
      "o",
      "--repo",
      "a/b",
      "--env",
      "e",
      "--public-pem-out",
      online,
    ]);
    assert.equal(gen.status, 0, gen.stderr);
    assert.equal(mode(online), "644");
    const signed = ctx.run(signArgs(ctx));
    assert.equal(signed.status, 0, signed.stderr);
    assert.equal(mode(join(ctx.root, "signed-trust.json")), "644");
    const cadencr = ctx.calls().find((call) => call.keyMode);
    assert.equal(cadencr.keyMode, "600");
    assert.equal(cadencr.dirMode, "700");
  },
);

test(
  "a pre-existing --public-pem-out is refused before any tool runs or anything is stored",
  { skip: skipNoOpenssl },
  () => {
    for (const command of [
      ["generate-root", "--key-id", "r", "--vault", "V"],
      ["generate-online", "--key-id", "o", "--repo", "a/b", "--env", "e"],
    ]) {
      const ctx = setup();
      const out = join(ctx.root, "taken.pem");
      writeFileSync(out, "precious");
      const result = ctx.run([...command, "--public-pem-out", out]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /refusing to overwrite existing/);
      assert.equal(readFileSync(out, "utf8"), "precious");
      assert.deepEqual(ctx.calls(), [], "no fake tool was called");
      assert.ok(!existsSync(join(ctx.state, "kc")) && !existsSync(join(ctx.state, "op")));
      assert.ok(!existsSync(join(ctx.state, "gh")));
      assertTmpEmpty(ctx);
      const missingDir = ctx.run([...command, "--public-pem-out", join(ctx.root, "nope", "x.pem")]);
      assert.match(missingDir.stderr, /directory does not exist/);
      assert.deepEqual(ctx.calls(), []);
    }
  },
);

test(
  "a Keychain failure after the 1Password write says the item exists and must be removed manually",
  { skip: skipNoOpenssl },
  () => {
    const ctx = setup();
    const result = ctx.run(["generate-root", "--key-id", "r", "--vault", "V"], {
      FAKE_SECURITY_FAIL: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Keychain write failed AFTER the 1Password item/);
    assert.match(result.stderr, /cadencr-marketplace-root-r/);
    assert.match(result.stderr, /Remove it manually/);
    assert.ok(
      existsSync(join(ctx.state, "op", "cadencr-marketplace-root-r")),
      "never auto-deleted",
    );
    assertTmpEmpty(ctx);
  },
);

test("X25519 keys are rejected where Ed25519 is required", { skip: skipNoOpenssl }, () => {
  const ctx = setup();
  const { publicB64 } = seedRoot(ctx);
  const x25519 = join(ctx.root, "x25519.pem");
  assert.equal(spawnSync(OPENSSL, ["genpkey", "-algorithm", "X25519", "-out", x25519]).status, 0);
  const xPublic = join(ctx.root, "x25519-pub.pem");
  assert.equal(spawnSync(OPENSSL, ["pkey", "-in", x25519, "-pubout", "-out", xPublic]).status, 0);
  const args = ["verify-backup", "--key-id", "root-1", "--vault", "Vault"];
  const badExpected = ctx.run([...args, "--expected-public-key", xPublic]);
  assert.notEqual(badExpected.status, 0);
  assert.match(badExpected.stderr, /expected public key is not Ed25519/);
  // A stored X25519 private key (both stores identical) is rejected too.
  const xStored = Buffer.from(readFileSync(x25519, "utf8")).toString("base64");
  writeFileSync(join(ctx.state, "kc", "cadencr-marketplace-root__root-1"), xStored);
  writeFileSync(join(ctx.state, "op", "cadencr-marketplace-root-root-1"), xStored);
  const badStored = ctx.run([...args, "--expected-public-key-base64", publicB64]);
  assert.notEqual(badStored.status, 0);
  assert.match(badStored.stderr, /key is not Ed25519/);
  assertTmpEmpty(ctx);
});

test("unsafe item titles, Keychain service names and paths are rejected up front", () => {
  const ctx = setup();
  const base = ["generate-root", "--key-id", "r", "--vault", "V"];
  for (const title of ['a"b', "a\\b", "a\nb", "a\u0007b", "a\n", "", "x".repeat(129)]) {
    if (title === "") continue; // empty means "use the default"
    const result = ctx.run([...base, "--item-title", title]);
    assert.notEqual(result.status, 0, JSON.stringify(title));
    assert.match(result.stderr, /--item-title must be/);
  }
  assert.match(
    ctx.run([
      "verify-backup",
      "--key-id",
      "r",
      "--vault",
      "V",
      "--item-title",
      "a\nb",
      "--expected-public-key-base64",
      "AAAA",
    ]).stderr,
    /--item-title must be/,
  );
  for (const service of ['svc"x', "svc\nx", "svc x", "-svc"]) {
    for (const command of [
      base,
      ["verify-backup", "--key-id", "r", "--vault", "V", "--expected-public-key-base64", "AAAA"],
    ]) {
      const result = ctx.run(command, { CADENCR_KEYS_SERVICE: service });
      assert.notEqual(result.status, 0, JSON.stringify(service));
      assert.match(result.stderr, /CADENCR_KEYS_SERVICE must match/);
    }
  }
  assert.match(ctx.run([...base, "--keychain", "/tmp/a\nb"]).stderr, /control characters/);
  assert.deepEqual(ctx.calls(), []);
});

test("generate-online is allowed off macOS without the override; Keychain commands are not", () => {
  const ctx = setup();
  const uname = join(ctx.bin, "uname");
  writeFileSync(uname, "#!/bin/sh\necho Linux\n");
  chmodSync(uname, 0o755);
  const linux = { UNAME_BIN: uname, CADENCR_KEYS_ALLOW_NON_DARWIN: "" };
  const online = ctx.run(
    ["generate-online", "--key-id", "o", "--repo", "a/b", "--env", "e", "--dry-run"],
    linux,
  );
  assert.equal(online.status, 0, online.stderr);
  assert.match(online.stdout, /^plan: /m);
  for (const command of [
    ["generate-root", "--key-id", "r", "--vault", "V", "--dry-run"],
    [
      "verify-backup",
      "--key-id",
      "r",
      "--vault",
      "V",
      "--expected-public-key-base64",
      "A",
      "--dry-run",
    ],
    [
      "sign-trust",
      "--payload",
      "p",
      "--output",
      "o",
      "--key-id",
      "r",
      "--root-public-key",
      "k",
      "--dry-run",
    ],
  ]) {
    const result = ctx.run(command, linux);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only runs on macOS/);
  }
});

test("refuses to run off macOS unless explicitly overridden", () => {
  const ctx = setup();
  const uname = join(ctx.bin, "uname");
  writeFileSync(uname, "#!/bin/sh\necho Linux\n");
  chmodSync(uname, 0o755);
  const blocked = ctx.run(["generate-root", "--key-id", "r", "--vault", "V", "--dry-run"], {
    UNAME_BIN: uname,
    CADENCR_KEYS_ALLOW_NON_DARWIN: "",
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /only runs on macOS/);
  const allowed = ctx.run(["generate-root", "--key-id", "r", "--vault", "V", "--dry-run"], {
    UNAME_BIN: uname,
  });
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("--dry-run prints the plan and runs no external tool", () => {
  const ctx = setup();
  writeFileSync(join(ctx.root, "payload.json"), "{}");
  writeFileSync(join(ctx.root, "root-pub.pem"), "x");
  const commands = [
    ["generate-root", "--key-id", "r", "--vault", "V"],
    ["generate-online", "--key-id", "o", "--repo", "a/b", "--env", "p", "--env", "q"],
    [
      "sign-trust",
      "--payload",
      join(ctx.root, "payload.json"),
      "--output",
      join(ctx.root, "o.json"),
      "--key-id",
      "r",
      "--root-public-key",
      join(ctx.root, "root-pub.pem"),
    ],
    ["verify-backup", "--key-id", "r", "--vault", "V", "--expected-public-key-base64", "AAAA"],
  ];
  for (const command of commands) {
    const result = ctx.run([...command, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^plan: /m);
  }
  assert.deepEqual(ctx.calls(), []);
  assertTmpEmpty(ctx);
});

test("rejects bad commands, options and ids", () => {
  const ctx = setup();
  assert.notEqual(ctx.run([]).status, 0);
  assert.match(ctx.run(["bogus"]).stderr, /unknown command/);
  assert.match(ctx.run(["generate-root", "--wat"]).stderr, /unknown option/);
  assert.match(ctx.run(["generate-root", "--key-id"]).stderr, /needs a value/);
  assert.match(
    ctx.run(["generate-root", "--vault", "V"]).stderr,
    /missing required option --key-id/,
  );
  assert.match(ctx.run(["generate-root", "--key-id", "a b", "--vault", "V"]).stderr, /must match/);
  assert.match(
    ctx.run(["generate-root", "--key-id", "r", "--vault", "V", "--keychain", 'x"y']).stderr,
    /quotes/,
  );
  assert.match(ctx.run(["--help"]).stdout, /Usage:/);
});

test("the script never enables shell tracing and keeps secrets off argv by construction", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(!/^\s*set\s+-[a-z]*x/m.test(source));
  assert.ok(!/\bset\s+-o\s+xtrace/.test(source));
});

test(
  "end to end with the real Rust CLI: generate, back up, sign generation 1 and verify",
  {
    skip: !OPENSSL
      ? skipNoOpenssl
      : existsSync(REAL_CADENCR)
        ? false
        : "target/debug/cadencr not built",
  },
  () => {
    const ctx = setup();
    ctx.env.CADENCR_BIN = REAL_CADENCR;
    const { pem, result: rootResult } = seedRoot(ctx);
    const online = ctx.run([
      "generate-online",
      "--key-id",
      "online-1",
      "--repo",
      "acme/registry",
      "--env",
      "publication",
    ]);
    assert.equal(online.status, 0, online.stderr);
    const onlinePublic = /base64, raw 32 bytes\): (\S+)/.exec(online.stdout)[1];
    const payload = join(ctx.root, "trust.json");
    writeFileSync(
      payload,
      JSON.stringify({
        schema_version: 1,
        kind: "registry-trust",
        generation: 1,
        keys: [{ key_id: "online-1", public_key_base64: onlinePublic }],
        revoked_key_ids: [],
      }),
    );
    const output = join(ctx.root, "signed-trust.json");
    const signed = ctx.run(
      [
        "sign-trust",
        "--payload",
        payload,
        "--output",
        output,
        "--key-id",
        "root-1",
        "--root-public-key",
        join(ctx.root, "root-pub.pem"),
        "--minimum-generation",
        "1",
      ],
      { CADENCR_BIN: REAL_CADENCR },
    );
    assert.equal(signed.status, 0, signed.stdout + signed.stderr);
    assert.match(signed.stderr, /valid registry trust generation 1/);
    assert.match(readFileSync(output, "utf8"), /"registry-trust"/);
    assertNoLeak(ctx, signed, pem);
    assertNoLeak(ctx, rootResult, pem);
    assertTmpEmpty(ctx);
  },
);
