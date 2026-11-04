import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const commit = "a".repeat(40);
const hash = (data) => createHash("sha256").update(data).digest("hex");
function packageMetadata(kind, id, version, targets) {
  return {
    kind,
    package: {
      [kind === "provider" ? "agent" : kind]: {
        id,
        name: id,
        version,
        description: "Inert fixture",
        repository: "https://github.com/merkr-software/CadencR",
        license: "MIT",
        ...(kind === "theme" ? { document_version: 1 } : kind === "tab" ? { api_version: 1 } : {}),
        distribution:
          kind === "provider"
            ? {
                binary: Object.fromEntries(
                  targets.map((target) => [
                    target,
                    {
                      archive: "https://example.invalid/fixture.tar.gz",
                      cmd: "bin/provider",
                      sha256: "0".repeat(64),
                    },
                  ]),
                ),
              }
            : { archive: "https://example.invalid/fixture.tar.gz", sha256: "0".repeat(64) },
      },
      host: {
        publisher: "fixture",
        compatibility: { min_app_version: "1.0.0" },
        ...(kind === "provider"
          ? { assets: { icon: "icon.svg", readme: "README.md", license: "LICENSE" } }
          : {}),
      },
    },
  };
}

function writeTools(root, realCli) {
  writeFileSync(
    join(root, "mock/git"),
    `#!/usr/bin/env python3
import json,sys,os,hashlib,pathlib,base64
args=sys.argv[3:]; data=json.load(open('${root}/files.json')); files=data['files']; modes=data['modes']
with open('${root}/git-calls','a') as log: log.write(json.dumps(args)+'\\n')
def content(path):
 value=files[path]; return base64.b64decode(value['base64']) if isinstance(value,dict) else value.encode()
def object_id(path):
 b=content(path); return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\\0'+b).hexdigest()
objects={object_id(path):content(path) for path in files}
if args[0]=='remote': print(os.environ.get('MOCK_ORIGIN','https://github.com/merkr-software/CadencR.git'))
elif args[0]=='rev-parse': print(os.environ.get('MOCK_TAG_COMMIT' if args[-1].startswith('refs/tags/') else 'MOCK_COMMIT','${commit}'))
elif args[0]=='ls-tree':
 path=args[-1]
 if '-r' in args:
  for key in sorted(files):
   if key.startswith(path): sys.stdout.buffer.write((modes.get(key,'100644')+' blob '+object_id(key)+'\\t'+key+'\\0').encode())
 else: print(modes.get(path,os.environ.get('MOCK_MODE','100644'))+' blob '+object_id(path)+'\\t'+path)
elif args[0]=='cat-file' and '--batch' in args:
 for line in sys.stdin.buffer:
  oid=line.strip().decode(); content=objects[oid]; size=str(len(content))
  override=pathlib.Path('${root}/batch-size')
  if override.exists(): size=override.read_text()
  sys.stdout.buffer.write((oid+' blob '+size+'\\n').encode()); sys.stdout.buffer.flush()
  if override.exists(): sys.exit(0)
  sys.stdout.buffer.write(content+b'\\n'); sys.stdout.buffer.flush()
elif args[0]=='cat-file': print(len(content(args[-1].split(':',1)[1])))
elif args[0]=='show': sys.stdout.buffer.write(content(args[-1].split(':',1)[1]))
else: sys.exit(1)
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(root, "cli"),
    `#!/usr/bin/env python3
import sys,json,pathlib,hashlib,os
assert 'SECRET_TEST' not in os.environ
args=sys.argv
if pathlib.Path('${root}/bad-cli').exists():
 sys.stderr.write('error[INERT_FIXTURE_FAILURE]: PRIVATE_DIAG_MARKER '+('sensitive-marker'*6000)); sys.exit(1)
with open('${root}/calls','a') as log: log.write(json.dumps(args[1:])+'\\n')
if args[1]=='plugin':
 if args[args.index('--kind')+1]=='tab': assert '--no-run' in args
 sys.exit(0)
if args[2]=='plan-publication':
 pathlib.Path(args[args.index('--output')+1]).write_text('{}'); sys.exit(0)
if args[2]=='pack-tab': assert '--package' in args
p=pathlib.Path(args[args.index('--output')+1]); stage=pathlib.Path(args[args.index('--directory')+1])
b=b''.join(str(f.relative_to(stage)).encode()+f.read_bytes() for f in sorted(stage.rglob('*')) if f.is_file()); p.write_bytes(b)
key={'target':args[args.index('--target')+1]} if args[2] in ('pack-provider','pack-tab-backend') else {'kind':args[2][5:]}
if args[2]=='pack-tab-backend':
 manifest=json.loads((stage/'tab.json').read_text()); cmd=manifest['backend']['binary'][key['target']]; executable=(stage/cmd).read_bytes()
 key.update(kind='tab-backend',cmd=cmd,executable_sha256=hashlib.sha256(executable).hexdigest(),executable_size=len(executable))
 corrupt=pathlib.Path('${root}/backend-receipt-field')
 if corrupt.exists(): key[corrupt.read_text()]='untrusted'
receipt=json.dumps(dict(key,archive=str(p),size=len(b),sha256=('0'*64 if pathlib.Path('${root}/bad-receipt').exists() else hashlib.sha256(b).hexdigest())))
invalid=pathlib.Path('${root}/invalid-receipt-json')
if invalid.exists():
 mode=invalid.read_text()
 receipt=receipt.replace('"size": ', '"size": 0, "size": ',1) if mode=='duplicate' else receipt[:-1]+',"invalid":'+mode+'}'
print(receipt)
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(root, "tooling/marketplace-registry/scripts/ci/fetch-released-cli.sh"),
    `#!/bin/sh
case "$1" in */cli-qualification.env) printf '%s\\n' '${realCli ?? root + "/cli"}';; *) echo 'Released Cadencr CLI pin is PENDING.' >&2; exit 3;; esac
`,
  );
}

function copyPreparation(root) {
  for (const name of [
    "official-plugin-release.sh",
    "official-plugin-prepare.py",
    "official_plugin_pack.py",
    "official_plugin_tags.py",
    "official_plugin_lsp.py",
    "official_plugin_lsp_archive.py",
  ])
    cpSync(resolve("scripts", name), join(root, "scripts", name));
}

export function fixture(kind = "theme", realCli) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "official-release-test-")));
  for (const dir of ["scripts", "tooling/marketplace-registry/scripts/ci", "mock"])
    mkdirSync(join(root, dir), { recursive: true });
  copyPreparation(root);
  const id = kind === "theme" ? "graphite" : kind === "provider" ? "pi" : "inert";
  const plugin = `${kind}-${id}`;
  const version = "1.0.0";
  const path = `plugins/${kind}s/${id}`;
  const targets = kind === "provider" ? ["linux-x86_64", "darwin-aarch64"] : [kind];
  const files = {};
  const modes = {};
  const payloads = {};
  for (const target of targets) {
    const directory = `${path}/prepared/${target}`;
    const contents =
      kind === "theme"
        ? { "theme.json": readFileSync(resolve("plugins/themes/graphite/theme.json"), "utf8") }
        : kind === "tab"
          ? {
              "tab.json": JSON.stringify({
                schema_version: 1,
                kind: "tab",
                id,
                name: id,
                version,
                api_version: 1,
                entry: "dist/index.html",
              }),
              "dist/index.html": "<!doctype html><title>Inert fixture</title>",
              "dist/app.js": "throw new Error('candidate payload must never execute')",
            }
          : {
              "bin/provider": "#!/bin/sh\nexit 99\n",
              "README.md": "inert",
              LICENSE: "MIT",
              "icon.svg": "<svg/>",
            };
    payloads[target] = { directory, files: {} };
    for (const [name, content] of Object.entries(contents)) {
      const mode = name === "bin/provider" ? "100755" : "100644";
      files[`${directory}/${name}`] = content;
      modes[`${directory}/${name}`] = mode;
      payloads[target].files[name] = { sha256: hash(content), mode };
    }
  }
  const entry = {
    kind,
    id,
    version,
    source_path: path,
    package: `${path}/package-template.json`,
    preparation: "READY",
    payloads,
  };
  const policy = { schema_version: 2, plugins: { [plugin]: entry }, publication: "PENDING" };
  files["plugins/release-policy.json"] = JSON.stringify(policy);
  files[entry.package] = JSON.stringify(packageMetadata(kind, id, version, targets));
  const save = () => writeFileSync(join(root, "files.json"), JSON.stringify({ files, modes }));
  save();
  writeTools(root, realCli);
  function run(
    tag = `plugins/${plugin}/v${version}`,
    extra = {},
    qualification = true,
    requestedOutput,
  ) {
    const output = requestedOutput ?? join(root, "public-" + Math.random());
    const result = spawnSync(
      "sh",
      [
        join(root, "scripts/official-plugin-release.sh"),
        ...(qualification === "author-approved"
          ? ["--author-approved"]
          : qualification
            ? ["--qualification"]
            : []),
        root,
        commit,
        tag,
        output,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: join(root, "mock") + ":" + process.env.PATH,
          SECRET_TEST: "sensitive-marker",
          GITHUB_REPOSITORY: "merkr-software/CadencR",
          GITHUB_SHA: commit,
          GITHUB_REF: "refs/tags/" + tag,
          ...extra,
        },
      },
    );
    return { ...result, output };
  }
  return { run, root, files, modes, entry, policy, save, plugin, version };
}

export function checkNamespacedTagBinding() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "official-tag-fetch-test-")));
  const origin = join(root, "origin");
  mkdirSync(origin);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Synthetic fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  function git(directory, args, input) {
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-C",
        directory,
        ...args,
      ],
      { encoding: "utf8", env, input, timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(origin, ["init", "--bare"]);
  const tree = git(origin, ["hash-object", "-w", "-t", "tree", "--stdin"], "");
  const parent = git(origin, ["commit-tree", tree], "synthetic parent\n");
  const expected = git(origin, ["commit-tree", tree, "-p", parent], "synthetic source\n");
  const tags = ["plugins/theme-graphite/v0.1.0", "plugins/theme-ember/v0.1.0"];
  git(origin, ["update-ref", "refs/tags/" + tags[0], expected]);
  git(origin, ["tag", "--no-sign", "-a", tags[1], expected, "-m", "synthetic annotated tag"]);
  assert.equal(git(origin, ["cat-file", "-t", "refs/tags/" + tags[1]]), "tag");
  for (const [index, tag] of tags.entries()) {
    const checkout = join(root, "checkout-" + index);
    mkdirSync(checkout);
    git(checkout, ["init"]);
    git(checkout, [
      "fetch",
      "--depth=1",
      "--no-tags",
      "file://" + origin,
      "+refs/tags/" + tag + ":refs/tags/" + tag,
    ]);
    assert.equal(git(checkout, ["rev-parse", "refs/tags/" + tag + "^{commit}"]), expected);
    assert.equal(git(checkout, ["rev-parse", "--is-shallow-repository"]), "true");
    assert.equal(git(checkout, ["rev-list", "--count", expected]), "1");
    assert.equal(readFileSync(join(checkout, ".git/shallow"), "utf8").trim(), expected);
  }
}

// Reviewed prebuilt bytes only: ELF header, deliberately not a runnable program.
export function nativeTabFixture(realCli) {
  const f = fixture("tab", realCli);
  const payload = f.entry.payloads.tab;
  const manifest = JSON.parse(f.files[`${payload.directory}/tab.json`]);
  const target = "linux-x86_64";
  const cmd = `bin/${target}/backend`;
  const reasoning = "Reports local fixture information.";
  manifest.backend = { protocol: 1, reasoning, binary: { [target]: cmd } };
  const manifestBytes = JSON.stringify(manifest);
  f.files[`${payload.directory}/tab.json`] = manifestBytes;
  payload.files["tab.json"].sha256 = hash(manifestBytes);
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  // Same minimal Mach-O headers/load commands as plugin-core test support.
  const macho = (cpu, signed) => {
    const commands = [0x1b, 24, 0, 0, 0, 0, ...(signed ? [0x1d, 16, 0, 0] : [])];
    const words = [0xfeedfacf, cpu, 0, 2, signed ? 2 : 1, commands.length * 4, 0, 0, ...commands];
    const image = Buffer.alloc(words.length * 4);
    words.forEach((word, index) => image.writeUInt32LE(word, index * 4));
    return image;
  };
  const binaries = {
    [target]: bytes,
    "darwin-x86_64": macho(0x01000007, false),
    "darwin-aarch64": macho(0x0100000c, true),
  };
  manifest.backend.binary = Object.fromEntries(
    Object.keys(binaries).map((key) => [key, `bin/${key}/backend`]),
  );
  const finalManifest = JSON.stringify(manifest);
  f.files[`${payload.directory}/tab.json`] = finalManifest;
  payload.files["tab.json"].sha256 = hash(finalManifest);
  const metadata = JSON.parse(f.files[f.entry.package]);
  metadata.package.tab.backend = { protocol: 1, reasoning };
  metadata.package.tab.distribution.binary = {};
  for (const [platform, executable] of Object.entries(binaries)) {
    const directory = `${f.entry.source_path}/prepared/backend-${platform}`;
    const command = manifest.backend.binary[platform];
    f.entry.payloads[`backend-${platform}`] = {
      directory,
      files: {
        "tab.json": { mode: "100644", sha256: hash(finalManifest) },
        [command]: { mode: "100755", sha256: hash(executable) },
      },
    };
    f.files[`${directory}/tab.json`] = finalManifest;
    f.files[`${directory}/${command}`] = { base64: executable.toString("base64") };
    f.modes[`${directory}/${command}`] = "100755";
    metadata.package.tab.distribution.binary[platform] = {
      archive: "https://example.invalid/backend.tar.gz",
      sha256: "0".repeat(64),
      size: 1,
      cmd: command,
      executable_sha256: "0".repeat(64),
      executable_size: 1,
    };
  }
  f.files[f.entry.package] = JSON.stringify(metadata);
  f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
  f.save();
  return { ...f, target, cmd, bytes, binaries };
}
