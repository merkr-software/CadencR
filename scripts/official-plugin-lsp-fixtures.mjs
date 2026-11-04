import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./official-plugin-fixtures.mjs";

export const lspTag = "lsp-typescript-language-server-v0.1.0";
export const preparationFiles = ["official-plugin-release.sh", "official-plugin-prepare.py",
  "official_plugin_pack.py", "official_plugin_tags.py", "official_plugin_lsp.py", "official_plugin_lsp_archive.py"];

export function lspFixture() {
  const base = fixture("provider");
  const policy = JSON.parse(readFileSync("plugins/release-policy.json"));
  const entry = structuredClone(policy.plugins["lsp-typescript-language-server"]);
  const files = base.files;
  base.policy.plugins = { "lsp-typescript-language-server": entry };
  files[entry.package] = readFileSync(entry.package, "utf8");
  for (const payload of Object.values(entry.payloads))
    for (const [name, spec] of Object.entries(payload.files))
      files[`${payload.directory}/${spec.source ?? name}`] = {
        base64: readFileSync(join(payload.directory, spec.source ?? name)).toString("base64"),
      };
  mkdirSync(join(base.root, "plugins"));
  const save = () => {
    files["plugins/release-policy.json"] = JSON.stringify(base.policy);
    writeFileSync(join(base.root, "plugins/release-policy.json"), files["plugins/release-policy.json"]);
    base.save();
  };
  save();
  const payload = Object.values(entry.payloads)[0];
  const canonical = resolve(payload.directory, "bundle.tar.gz");
  writeFileSync(join(base.root, "cli"), `#!/usr/bin/env python3
import hashlib,json,os,pathlib,sys
assert 'SECRET_TEST' not in os.environ
args=sys.argv[1:]
with open('${base.root}/calls','a') as log: log.write(json.dumps(args)+'\\n')
if args[:2]==['plugin','validate']:
 assert args[-2:]==['--kind','lsp']
 assert (pathlib.Path(args[2])/'lsp.json').is_file()
 sys.exit(0)
if args[:2]==['registry','plan-publication']:
 pathlib.Path(args[args.index('--output')+1]).write_text('{}');sys.exit(0)
assert args[:2]==['registry','pack-lsp']
assert args[args.index('--runtime')+1]=='node'
assert args[args.index('--entry')+1]=='lib/cli.mjs'
source=pathlib.Path(args[args.index('--directory')+1]);output=pathlib.Path(args[args.index('--output')+1])
assert not (source/'lsp.json').exists()
data=pathlib.Path('${canonical}').read_bytes();output.write_bytes(data)
entry=(source/'lib/cli.mjs').read_bytes()
print(json.dumps(dict(kind='lsp',target=args[args.index('--target')+1],archive=str(output),
 sha256=hashlib.sha256(data).hexdigest(),size=len(data),entry='lib/cli.mjs',
 entry_sha256=hashlib.sha256(entry).hexdigest(),entry_size=len(entry),runtime='node')))
`, { mode: 0o700 });
  return { ...base, entry, save, plugin: "lsp-typescript-language-server", version: "0.1.0",
    run: (tag = lspTag, ...args) => base.run(tag, ...args) };
}
