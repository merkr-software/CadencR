import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const sha = "a".repeat(40);
const zero = "0".repeat(64);
const hash = (data) => createHash("sha256").update(data).digest("hex");
function mockHttp(root) {
  writeFileSync(
    join(root, "py/sitecustomize.py"),
    `import io,json,os,urllib.request
class Opener:
 def open(self,request,**k):
  url=request.full_url if isinstance(request,urllib.request.Request) else request
  if 'deployment-branch-policies' in url: data={'total_count':1,'branch_policies':[{'name':'main','type':'branch'}]}
  elif 'environments/' in url: data={'id':123,'protection_rules':[{'type':'required_reviewers','prevent_self_review':True,'reviewers':[{'type':'User','reviewer':{'id':1}}]}],'deployment_branch_policy':{'protected_branches':False,'custom_branch_policies':True}}
  else: data={'id':42,'full_name':'merkr-software/CadencR'}
  if os.environ.get('MOCK_REVIEW_RULE') and 'protection_rules' in data: data['protection_rules']=json.loads(os.environ['MOCK_REVIEW_RULE'])
  if os.environ.get('MOCK_ENV_ID') and 'environments/' in url: data['id']=124
  if os.environ.get('MOCK_ENV_BYPASS') and 'environments/' in url: data['can_admins_bypass']=True
  if os.environ.get('MOCK_ENV_UNPROTECTED') and 'environments/' in url: data={}
  if os.environ.get('MOCK_REPO_MISMATCH') and 'environments/' not in url: data={'id':43}
  return io.BytesIO(json.dumps(data).encode())
def build_opener(*a): return Opener()
urllib.request.build_opener=build_opener
`,
  );
}

export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "author-gate-")));
  for (const dir of ["scripts", "plugins", "mock", "py"])
    mkdirSync(join(root, dir), { recursive: true });
  for (const file of [
    "official-plugin-author-gate.sh",
    "official-plugin-author-stage.sh",
    "official_plugin_author_review.py",
    "official_plugin_tags.py",
    "official-plugin-author-policy.json",
    "official-plugin-author-cli.env",
  ])
    cpSync(resolve("scripts", file), join(root, "scripts", file));
  mockHttp(root);
  const policyPath = join(root, "scripts/official-plugin-author-policy.json");
  const releasePath = join(root, "plugins/release-policy.json");
  writeFileSync(releasePath, JSON.stringify({ schema_version: 1, publication: "PENDING" }));
  const env = {
    ...process.env,
    PATH: join(root, "mock") + ":" + process.env.PATH,
    PYTHONPATH: join(root, "py"),
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "merkr-software/CadencR",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF:
      "merkr-software/CadencR/.github/workflows/official-plugin-author.yml@refs/heads/main",
  };
  function approve() {
    const pin = "CADENCR_RELEASE_VERSION=1.0.0\nCADENCR_RELEASE_SHA256=" + zero + "\n";
    writeFileSync(join(root, "scripts/official-plugin-author-cli.env"), pin);
    const evidence = JSON.stringify({
      schema_version: 1,
      author_release_contract: "QUALIFIED",
      cli_version: "1.0.0",
      cli_sha256: zero,
    });
    writeFileSync(join(root, "scripts/official-plugin-author-qualification.json"), evidence);
    writeFileSync(
      policyPath,
      JSON.stringify({
        schema_version: 1,
        publication: "APPROVED",
        repository: "merkr-software/CadencR",
        repository_id: 42,
        author_account: "author",
        environment_id: 123,
        environment_review_policy: {
          environment_id: 123,
          prevent_self_review: true,
          reviewers: [{ type: "User", id: 1 }],
        },
        admin_bypass_reviewed_disabled: true,
        author_cli_version: "1.0.0",
        author_cli_sha256: zero,
        author_cli_qualification_sha256: hash(evidence),
        author_cli_pin_sha256: hash(pin),
      }),
    );
    writeFileSync(
      releasePath,
      JSON.stringify({
        schema_version: 2,
        publication: "APPROVED",
        plugins: {
          "theme-graphite": {
            kind: "theme",
            id: "graphite",
            version: "0.1.0",
            preparation: "READY",
          },
        },
      }),
    );
    writeFileSync(
      join(root, "mock/git"),
      `#!/bin/sh\ncase "$3" in\nls-tree) echo '100644 blob hash' ;;\nshow) cat '${releasePath}' ;;\nrev-parse) printf '%s\\n' '${sha}' ;;\n*) exit 1 ;;\nesac\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(root, "scripts/official-plugin-release.sh"),
      `#!/bin/sh
python3 - "$5" <<'MOCK'
import pathlib,json,hashlib,sys
p=pathlib.Path(sys.argv[1]);p.mkdir();(p/'theme.tar.gz').write_bytes(b'archive');(p/'package.json').write_bytes(b'{}');(p/'submission.json').write_bytes(b'{}');(p/'SHA256SUMS').write_bytes(b'sums')
def asset(name):
 b=(p/name).read_bytes();return {'name':name,'size':len(b),'sha256':hashlib.sha256(b).hexdigest()}
(p/'release.json').write_text(json.dumps({'schema_version':2,'archives':[dict(asset('theme.tar.gz'),target='theme')],'package':asset('package.json')}))
MOCK
`,
      { mode: 0o700 },
    );
  }
  function run(script, args) {
    return spawnSync("sh", [join(root, "scripts", script), ...args], { env, encoding: "utf8" });
  }
  return { root, env, approve, run, stage: makeStage(root, run), policyPath };
}

function makeStage(root, run) {
  return (digest = zero, tag = "plugins/theme-graphite/v0.1.0") => {
    const output = join(root, "out-" + Math.random());
    return { ...run("official-plugin-author-stage.sh", [root, sha, tag, digest, output]), output };
  };
}
