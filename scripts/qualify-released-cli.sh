#!/bin/sh
# Offline qualification of the exact distributed Linux ELF, never a source build.
set -eu
: "${CLI:?CLI absolute path is required}"
: "${CLI_WORK_ROOT:?CLI_WORK_ROOT new absolute directory is required}"
[ -z "${CADENCR_REGISTRY_GITHUB_TOKEN:-}" ] || { echo 'write token forbidden' >&2; exit 2; }
[ -z "${GITHUB_TOKEN:-}" ] || { echo 'GitHub token forbidden' >&2; exit 2; }
SCRIPT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
export SCRIPT_ROOT CLI CLI_WORK_ROOT
# Refuse unexpected paths before executing anything or creating state.
python3 - <<'PY'
import os, pathlib, hashlib
p=pathlib.Path(os.environ['CLI']); w=pathlib.Path(os.environ['CLI_WORK_ROOT'])
if not p.is_absolute() or p.is_symlink() or not p.is_file() or str(p.resolve())!=str(p): raise SystemExit('CLI must be an absolute regular non-symlink path')
if not w.is_absolute() or w.exists() or w.is_symlink() or str(w.parent.resolve())!=str(w.parent) or not w.parent.is_dir(): raise SystemExit('work root must be a new owned absolute directory with a canonical parent')
pins={line.split('=',1)[0]:line.split('=',1)[1] for line in (pathlib.Path(os.environ['SCRIPT_ROOT'])/'cli-qualification.env').read_text().splitlines() if line and not line.startswith('#')}
if pins!={'CADENCR_RELEASE_VERSION':'0.13.0','CADENCR_RELEASE_SHA256':'d3223e3b3ff74543595fd3354c3249f50fa01def65f376a624eb1fbc8072df2a'}: raise SystemExit('unexpected qualification pins')
if p.stat().st_size>134217728: raise SystemExit('CLI exceeds size limit')
if hashlib.file_digest(p.open('rb'),'sha256').hexdigest()!=pins['CADENCR_RELEASE_SHA256']: raise SystemExit('CLI digest mismatch')
if p.open('rb').read(4)!=b'\x7fELF' or not os.access(p,os.X_OK): raise SystemExit('CLI must be executable ELF')
w.mkdir(mode=0o700)
PY
umask 077
mkdir "$CLI_WORK_ROOT/keys" "$CLI_WORK_ROOT/logs" "$CLI_WORK_ROOT/home" "$CLI_WORK_ROOT/evidence"
status=failed
cleanup() {
  # Only these two generated disposable key files are removed. Never recurse.
  rm -f "$CLI_WORK_ROOT/keys/private.pem" "$CLI_WORK_ROOT/keys/public.pem"
  QUALIFICATION_STATUS=$status export QUALIFICATION_STATUS
  python3 - <<'PY'
import os,json,pathlib,hashlib
root=pathlib.Path(os.environ['CLI_WORK_ROOT'])
e={'schema_version':1,'qualification':'offline-only','status':os.environ['QUALIFICATION_STATUS'],'version':'0.13.0','cli_sha256':hashlib.file_digest(open(os.environ['CLI'],'rb'),'sha256').hexdigest(),'public_publication':'pending','interruption_resume':'pending','fresh_runner_recovery':'pending','renewal':'pending','lifecycle_qualified':False,'production_pins_changed':False,'keys':'disposable-test-keys-only-never-uploaded','checks':[]}
for p in sorted((root/'logs').glob('*.passed')): e['checks'].append(p.stem)
e['artifact_sha256']={}
for name in ['provider-1.tar.gz','theme-1.tar.gz','payload.json','signed.json','signed-policy.json']:
 p=root/name
 if p.is_file() and not p.is_symlink(): e['artifact_sha256'][name]=hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
(root/'evidence'/'evidence.json').write_text(json.dumps(e,indent=2)+'\n')
PY
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
run() {
  name=$1; shift
  # 64 KiB file cap and wall-clock/process-group bounds. No inherited credentials.
  result=0
  (ulimit -f 128; exec timeout --kill-after=2s 30s env -i PATH="$PATH" HOME="$CLI_WORK_ROOT/home" "$CLI" "$@") > "$CLI_WORK_ROOT/logs/$name.out" 2> "$CLI_WORK_ROOT/logs/$name.err" || result=$?
  [ "$result" -eq 0 ] || return "$result"
  touch "$CLI_WORK_ROOT/logs/$name.passed"
}
reject() {
  name=$1; expected_code=$2; shift 2
  if run "$name" "$@"; then echo "unexpected acceptance: $name" >&2; exit 1; fi
  # Timeout, output overflow and launch failure are not semantic rejection proof.
  test -s "$CLI_WORK_ROOT/logs/$name.err"
  python3 - "$CLI_WORK_ROOT/logs/$name.err" "$expected_code" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
if value.get('ok') is not False or value.get('code')!=sys.argv[2]: raise SystemExit('unexpected CLI rejection diagnostic')
PY
  touch "$CLI_WORK_ROOT/logs/$name.passed"
}
run version --version
[ "$(cat "$CLI_WORK_ROOT/logs/version.out")" = 'cadencr 0.13.0' ]
python3 - <<'PY'
import os,pathlib,json,datetime,shutil
r=pathlib.Path(os.environ['CLI_WORK_ROOT']); s=pathlib.Path(os.environ['SCRIPT_ROOT'])
for name in ['provider/bin','provider/assets','theme','invalid-theme','base/packages','candidate/packages','packages','nested','malformed','nonfinite']: (r/name).mkdir(parents=True)
p=json.loads((s.parent/'tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture').read_text())
(r/'provider-package.json').write_text(json.dumps(p))
(r/'provider/bin/example-provider').write_text('inert qualification data, must never execute\n'); (r/'provider/bin/example-provider').chmod(0o700)
(r/'provider/bin/provider').write_text('inert qualification data, must never execute\n'); (r/'provider/bin/provider').chmod(0o700)
(r/'qualification.json').write_text(json.dumps({'schema_version':1,'agent':{'id':'qualification','name':'Qualification','version':'1.0.0','description':'Inert provider fixture'},'installation':{'executable':{'command':str(r/'provider/bin/provider')}}}))
for name,content in [('assets/icon.svg','<svg/>'),('README.md','Inert qualification fixture'),('LICENSE','Apache-2.0')]: (r/'provider'/name).write_text(content)
shutil.copyfile(s/'fixtures/cli-qualification-theme.json',r/'theme/theme.json')
bad_theme=json.loads((r/'theme/theme.json').read_text()); bad_theme['cssVars']['--foreground']='rgb(nan 0 0)'; (r/'invalid-theme/theme.json').write_text(json.dumps(bad_theme))
(r/'base/packages/example-provider-0.1.0.json').write_text(json.dumps(p)); (r/'candidate/packages/example-provider-0.1.0.json').write_text(json.dumps(p)); (r/'packages/example-provider-0.1.0.json').write_text(json.dumps(p))
t={'kind':'theme','package':{'theme':{'id':'qualification','name':'Qualification','description':'Inert theme fixture','version':'1.0.0','license':'MIT','repository':'https://github.com/acme/qualification-themes','document_version':1,'distribution':{'archive':'https://github.com/acme/qualification-themes/releases/download/v1.0.0/theme.tar.gz','sha256':'a'*64}},'host':{'publisher':'qualification','compatibility':{'min_app_version':'0.13.0'}}}}
(r/'packages/qualification-1.0.0.json').write_text(json.dumps(t))
(r/'nested/bad.json').write_text(json.dumps({'kind':'provider','package':{'kind':'provider','package':p}}))
(r/'malformed/bad.json').write_text('{'); (r/'nonfinite/bad.json').write_text('{"value":1e999}')
now=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
f=lambda d:d.isoformat().replace('+00:00','Z')
(r/'generated').write_text(f(now-datetime.timedelta(minutes=1))); (r/'expires').write_text(f(now+datetime.timedelta(hours=1)))
(r/'policy.json').write_text(json.dumps({'schema_version':1,'kind':'theme-blocklist','generated_at':f(now-datetime.timedelta(minutes=1)),'expires_at':f(now+datetime.timedelta(hours=1)),'entries':[]}))
PY
run validate-provider-folder plugin validate "$CLI_WORK_ROOT/provider" --descriptor "$CLI_WORK_ROOT/qualification.json"
run validate-provider registry validate --base "$CLI_WORK_ROOT/base" --candidate "$CLI_WORK_ROOT/candidate"
run validate-theme plugin validate "$CLI_WORK_ROOT/theme" --kind theme
reject reject-theme-nonfinite-color THEME_VALIDATION_FAILED --json plugin validate "$CLI_WORK_ROOT/invalid-theme" --kind theme
for n in 1 2; do
  run "pack-provider-$n" registry pack-provider --package "$CLI_WORK_ROOT/provider-package.json" --target darwin-aarch64 --directory "$CLI_WORK_ROOT/provider" --output "$CLI_WORK_ROOT/provider-$n.tar.gz"
  run "pack-theme-$n" registry pack-theme --directory "$CLI_WORK_ROOT/theme" --output "$CLI_WORK_ROOT/theme-$n.tar.gz"
done
cmp "$CLI_WORK_ROOT/provider-1.tar.gz" "$CLI_WORK_ROOT/provider-2.tar.gz"
cmp "$CLI_WORK_ROOT/theme-1.tar.gz" "$CLI_WORK_ROOT/theme-2.tar.gz"
touch "$CLI_WORK_ROOT/logs/deterministic-packs.passed"
generated=$(cat "$CLI_WORK_ROOT/generated"); expires=$(cat "$CLI_WORK_ROOT/expires")
run build-mixed registry build-index --schema-version 2 --packages "$CLI_WORK_ROOT/packages" --generated-at "$generated" --expires-at "$expires" --output "$CLI_WORK_ROOT/payload.json"
for name in nested malformed nonfinite; do
  reject "reject-$name" REGISTRY_INDEX_FAILED --json registry build-index --schema-version 2 --packages "$CLI_WORK_ROOT/$name" --generated-at "$generated" --expires-at "$expires" --output "$CLI_WORK_ROOT/rejected-$name.json"
  test ! -e "$CLI_WORK_ROOT/rejected-$name.json"
done
# Keys generated only after local validation; never included in uploaded evidence.
openssl genpkey -algorithm ED25519 -out "$CLI_WORK_ROOT/keys/private.pem" 2>/dev/null
openssl pkey -in "$CLI_WORK_ROOT/keys/private.pem" -pubout -out "$CLI_WORK_ROOT/keys/public.pem" 2>/dev/null
run sign-mixed registry sign-index --payload "$CLI_WORK_ROOT/payload.json" --private-key "$CLI_WORK_ROOT/keys/private.pem" --key-id qualification-only --output "$CLI_WORK_ROOT/signed.json"
run verify-mixed registry verify-index --index "$CLI_WORK_ROOT/signed.json" --public-key "$CLI_WORK_ROOT/keys/public.pem" --key-id qualification-only
run sign-theme-policy registry sign-theme-blocklist --payload "$CLI_WORK_ROOT/policy.json" --private-key "$CLI_WORK_ROOT/keys/private.pem" --key-id qualification-only --output "$CLI_WORK_ROOT/signed-policy.json"
run verify-theme-policy registry verify-theme-blocklist --index "$CLI_WORK_ROOT/signed-policy.json" --public-key "$CLI_WORK_ROOT/keys/public.pem" --key-id qualification-only
reject reject-overwrite OUTPUT_WRITE_FAILED --json registry sign-index --payload "$CLI_WORK_ROOT/payload.json" --private-key "$CLI_WORK_ROOT/keys/private.pem" --key-id qualification-only --output "$CLI_WORK_ROOT/signed.json"
python3 - <<'PY'
import os,pathlib,json,datetime
r=pathlib.Path(os.environ['CLI_WORK_ROOT']); e=json.loads((r/'signed.json').read_text())
if e['signed']['schema_version']!=2 or len(e['signed']['packages'])!=2: raise SystemExit('mixed catalog assertion failed')
p=json.loads((r/'signed-policy.json').read_text())
# Preserve a well-shaped policy while changing authenticated bytes.
p['signed']['generated_at']=(datetime.datetime.fromisoformat(p['signed']['generated_at'].replace('Z','+00:00'))+datetime.timedelta(seconds=1)).isoformat().replace('+00:00','Z')
(r/'tampered-policy.json').write_text(json.dumps(p))
PY
reject reject-signed-policy-tampering REGISTRY_VERIFICATION_FAILED --json registry verify-theme-blocklist --index "$CLI_WORK_ROOT/tampered-policy.json" --public-key "$CLI_WORK_ROOT/keys/public.pem" --key-id qualification-only
status=passed
