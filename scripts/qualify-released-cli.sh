#!/bin/sh
# Offline qualification of the exact distributed Linux ELF, never a source build.
set -eu
: "${CLI:?CLI absolute path is required}"
: "${CLI_WORK_ROOT:?CLI_WORK_ROOT new absolute directory is required}"
[ -z "${CADENCR_REGISTRY_GITHUB_TOKEN:-}" ] || { echo 'write token forbidden' >&2; exit 2; }
[ -z "${GITHUB_TOKEN:-}" ] || { echo 'GitHub token forbidden' >&2; exit 2; }
[ -z "${GH_TOKEN:-}" ] || { echo 'GitHub token forbidden' >&2; exit 2; }
SCRIPT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
CLI_QUALIFICATION_PINS=${CLI_QUALIFICATION_PINS:-$SCRIPT_ROOT/cli-qualification.env}
export SCRIPT_ROOT CLI CLI_WORK_ROOT CLI_QUALIFICATION_PINS
# Refuse unexpected paths before executing anything or creating state.
python3 - <<'PY'
import os, pathlib, hashlib, re
p=pathlib.Path(os.environ['CLI']); w=pathlib.Path(os.environ['CLI_WORK_ROOT'])
if not p.is_absolute() or p.is_symlink() or not p.is_file() or str(p.resolve())!=str(p): raise SystemExit('CLI must be an absolute regular non-symlink path')
if not w.is_absolute() or w.exists() or w.is_symlink() or str(w.parent.resolve())!=str(w.parent) or not w.parent.is_dir(): raise SystemExit('work root must be a new owned absolute directory with a canonical parent')
pin_path=pathlib.Path(os.environ['CLI_QUALIFICATION_PINS'])
if not pin_path.is_absolute() or pin_path.is_symlink() or not pin_path.is_file() or pin_path.stat().st_size>1024: raise SystemExit('pins must be a bounded absolute regular non-symlink file')
lines=[line for line in pin_path.read_text().splitlines() if line and not line.startswith('#')]
if len(lines) not in (2,3) or any('=' not in line for line in lines): raise SystemExit('invalid qualification pins')
pins=dict(line.split('=',1) for line in lines)
if len(pins)!=len(lines) or set(pins) not in ({'CADENCR_RELEASE_VERSION','CADENCR_RELEASE_SHA256'}, {'CADENCR_RELEASE_VERSION','CADENCR_RELEASE_SHA256','CADENCR_RELEASE_TAG'}) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})(?:-dev\.(?:0|[1-9][0-9]{0,19})\.(?:0|[1-9][0-9]{0,4}))?',pins['CADENCR_RELEASE_VERSION']) or not re.fullmatch('[a-f0-9]{64}',pins['CADENCR_RELEASE_SHA256']): raise SystemExit('invalid qualification pins')
if 'CADENCR_RELEASE_TAG' in pins and (not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-dev\.[1-9][0-9]*\.[1-9][0-9]*)?',pins['CADENCR_RELEASE_VERSION']) or pins['CADENCR_RELEASE_TAG']!='cli/v'+pins['CADENCR_RELEASE_VERSION']): raise SystemExit('invalid qualification pins tag')
if p.stat().st_size>134217728: raise SystemExit('CLI exceeds size limit')
if hashlib.file_digest(p.open('rb'),'sha256').hexdigest()!=pins['CADENCR_RELEASE_SHA256']: raise SystemExit('CLI digest mismatch')
if p.open('rb').read(4)!=b'\x7fELF' or not os.access(p,os.X_OK): raise SystemExit('CLI must be executable ELF')
w.mkdir(mode=0o700)
(w/'reviewed-version').write_text(pins['CADENCR_RELEASE_VERSION'])
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
e={'schema_version':1,'qualification':'offline-only','status':os.environ['QUALIFICATION_STATUS'],'version':(root/'reviewed-version').read_text(),'cli_sha256':hashlib.file_digest(open(os.environ['CLI'],'rb'),'sha256').hexdigest(),'public_publication':'pending','interruption_resume':'pending','fresh_runner_recovery':'pending','renewal':'pending','lifecycle_qualified':False,'production_pins_changed':False,'native_backend_conformance':'not-run-inert-fixtures','native_archive_install_validation':'pending','keys':'disposable-test-keys-only-never-uploaded','checks':[]}
for p in sorted((root/'logs').glob('*.passed')): e['checks'].append(p.stem)
e['artifact_sha256']={}
for name in ['provider-1.tar.gz','theme-1.tar.gz','tab-1.tar.gz','payload.json','signed.json','signed-policy.json','native-ui-1.tar.gz','native-package.json','native-author-request.json']+[f'native-{p}-1.tar.gz' for p in ['darwin-aarch64','darwin-x86_64','linux-x86_64']]:
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
  case "$name" in
    version|validate-metadata-*|validate-submission-*|validate-native-metadata|validate-native-submission|inspect-native-author|expiry-*) ;;
    *) touch "$CLI_WORK_ROOT/logs/$name.passed" ;;
  esac
}
reject() {
  name=$1; expected_code=$2; shift 2
  if run "$name" "$@"; then echo "unexpected acceptance: $name" >&2; exit 1; fi
  # Timeout, output overflow and launch failure are not semantic rejection proof.
  expected_result=1
  [ "$expected_code" != OUTPUT_WRITE_FAILED ] || expected_result=3
  test "$result" -eq "$expected_result"
  test ! -s "$CLI_WORK_ROOT/logs/$name.out"
  test -s "$CLI_WORK_ROOT/logs/$name.err"
  python3 - "$CLI_WORK_ROOT/logs/$name.err" "$expected_code" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
if value.get('ok') is not False or value.get('code')!=sys.argv[2]: raise SystemExit('unexpected CLI rejection diagnostic')
PY
  touch "$CLI_WORK_ROOT/logs/$name.passed"
}
run version --version
[ "$(cat "$CLI_WORK_ROOT/logs/version.out")" = "cadencr $(cat "$CLI_WORK_ROOT/reviewed-version")" ]
touch "$CLI_WORK_ROOT/logs/version.passed"
python3 - <<'PY'
import os,pathlib,json,datetime,shutil
r=pathlib.Path(os.environ['CLI_WORK_ROOT']); s=pathlib.Path(os.environ['SCRIPT_ROOT'])
for name in ['provider/bin','provider/assets','theme','invalid-theme','base/packages','candidate/packages','packages','nested','malformed','nonfinite','qualification-tab/dist']: (r/name).mkdir(parents=True)
p=json.loads((s.parent/'tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture').read_text())
# QA-only GitHub-shaped provenance enables strict new-contribution checks.
p['agent']['repository']='https://github.com/acme/example-provider'
p['agent']['distribution']['binary']['darwin-aarch64']['archive']='https://github.com/acme/example-provider/releases/download/v0.1.0/example-provider-darwin-aarch64.tar.gz'
(r/'provider-package.json').write_text(json.dumps(p))
(r/'provider/bin/example-provider').write_text('inert qualification data, must never execute\n'); (r/'provider/bin/example-provider').chmod(0o700)
(r/'provider/bin/provider').write_text('inert qualification data, must never execute\n'); (r/'provider/bin/provider').chmod(0o700)
(r/'qualification.json').write_text(json.dumps({'schema_version':1,'agent':{'id':'qualification','name':'Qualification','version':'1.0.0','description':'Inert provider fixture'},'installation':{'executable':{'command':str(r/'provider/bin/provider')}}}))
for name,content in [('assets/icon.svg','<svg/>'),('README.md','Inert qualification fixture'),('LICENSE','Apache-2.0')]: (r/'provider'/name).write_text(content)
shutil.copyfile(s/'fixtures/cli-qualification-theme.json',r/'theme/theme.json')
bad_theme=json.loads((r/'theme/theme.json').read_text()); bad_theme['cssVars']['--foreground']='rgb(nan 0 0)'; (r/'invalid-theme/theme.json').write_text(json.dumps(bad_theme))
(r/'packages/example-provider-0.1.0.json').write_text(json.dumps(p))
t={'kind':'theme','package':{'theme':{'id':'qualification','name':'Qualification','description':'Inert theme fixture','version':'1.0.0','license':'MIT','repository':'https://github.com/acme/qualification-themes','document_version':1,'distribution':{'archive':'https://github.com/acme/qualification-themes/releases/download/v1.0.0/theme.tar.gz','sha256':'a'*64}},'host':{'publisher':'qualification','compatibility':{'min_app_version':'0.13.0'}}}}
(r/'packages/qualification-1.0.0.json').write_text(json.dumps(t))
tab={'schema_version':1,'kind':'tab','id':'qualification-tab','name':'Qualification tab','version':'1.0.0','api_version':1,'entry':'dist/index.html'}
(r/'qualification-tab/tab.json').write_text(json.dumps(tab))
(r/'qualification-tab/dist/index.html').write_text('<!doctype html><title>Inert qualification fixture</title>')
(r/'qualification-tab/dist/inert.js').write_text("throw new Error('fixture must never execute')")
metadata={'kind':'tab','package':{'tab':{'id':tab['id'],'name':tab['name'],'version':tab['version'],'api_version':1,'description':'Inert tab fixture','repository':'https://github.com/acme/tabs','license':'MIT','distribution':{'archive':'https://github.com/acme/tabs/releases/download/v1.0.0/tab.tar.gz','sha256':'a'*64}},'host':t['package']['host']}}
# Artificial QA-only compatibility: no shipped application support is asserted.
metadata['package']['host']=json.loads(json.dumps(t['package']['host']))
metadata['package']['host']['compatibility']['min_app_version']='999.0.0'
(r/'tab-package.json').write_text(json.dumps(metadata))
(r/'packages/qualification-tab-1.0.0.json').write_text(json.dumps(metadata))
for field,value in [('id','different'),('name','Different'),('version','1.0.1'),('api_version',2)]:
 bad=json.loads(json.dumps(metadata)); bad['package']['tab'][field]=value
 (r/('tab-wrong-'+field+'.json')).write_text(json.dumps(bad))
for label,bad in [('unknown',dict(metadata,extra=True)),('nested',{'kind':'provider','package':metadata})]:
 (r/('tab-wrong-'+label+'.json')).write_text(json.dumps(bad))
(r/'candidate/submissions').mkdir()
for name,value in [('example-provider-0.1.0.json',{'kind':'provider','package':p}),('qualification-1.0.0.json',t),('qualification-tab-1.0.0.json',metadata)]:
 (r/'candidate/packages'/name).write_text(json.dumps(value))
 descriptor=value['package']['agent' if value['kind']=='provider' else value['kind']]
 submission={'schema_version':2,'package':value,'source':{'repository':descriptor['repository'],'commit':'b'*40,'tag':'v'+descriptor['version']},'changelog':'Inert qualification release'}
 (r/'candidate/submissions'/name).write_text(json.dumps(submission))
# This is a malformed envelope probe, not proof of duplicate-key rejection.
(r/'tab-wrong-malformed-envelope.json').write_text('{"kind":"tab"}')

(r/'nested/bad.json').write_text(json.dumps({'kind':'provider','package':{'kind':'provider','package':p}}))
(r/'malformed/bad.json').write_text('{'); (r/'nonfinite/bad.json').write_text('{"value":1e999}')
now=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
f=lambda d:d.isoformat().replace('+00:00','Z')
(r/'generated').write_text(f(now-datetime.timedelta(minutes=1))); (r/'expires').write_text(f(now+datetime.timedelta(hours=1)))
# Local diagnostic data; intentionally unauthenticated envelopes establish no trust.
for kind,name in [('provider','example-provider-0.1.0.json'),('theme','qualification-1.0.0.json'),('tab','qualification-tab-1.0.0.json')]:
 value=json.loads((r/'candidate/submissions'/name).read_text())
 (r/('submission-'+kind+'.json')).write_text(json.dumps(value))
 for label in ['nested','unknown','provenance']:
  bad=json.loads(json.dumps(value))
  if label=='nested': bad['package']={'kind':kind,'package':bad['package']}
  elif label=='unknown': bad['source']['extra']=True
  else: bad['source']['repository']='https://github.com/other/repository'
  (r/('submission-'+kind+'-'+label+'.json')).write_text(json.dumps(bad))
for label,hours in [('expired',-1),('renewal-due',24),('healthy',168)]:
 (r/('expiry-'+label+'.json')).write_text(json.dumps({'signed':{'generated_at':f(now-datetime.timedelta(hours=48)),'expires_at':f(now+datetime.timedelta(hours=hours))},'signature':{}}))
(r/'metadata-link.json').symlink_to(r/'provider-package.json')
os.mkfifo(r/'metadata-fifo.json')
(r/'expiry-link.json').symlink_to(r/'expiry-healthy.json')
os.mkfifo(r/'expiry-fifo.json')
for name,source,limit in [('metadata','provider-package.json',32*1024*1024),('submission','submission-provider.json',1024*1024),('expiry','expiry-healthy.json',32*1024*1024)]:
 (r/(name+'-oversized.json')).write_text((r/source).read_text()+' '*limit)
(r/'policy.json').write_text(json.dumps({'schema_version':1,'kind':'theme-blocklist','generated_at':f(now-datetime.timedelta(minutes=1)),'expires_at':f(now+datetime.timedelta(hours=1)),'entries':[]}))
PY
# Exercise the released semantic boundaries, never execute contributor fixtures.
for kind in provider theme tab; do
  case "$kind" in
    provider) metadata="$CLI_WORK_ROOT/provider-package.json" ;;
    theme) metadata="$CLI_WORK_ROOT/packages/qualification-1.0.0.json" ;;
    tab) metadata="$CLI_WORK_ROOT/tab-package.json" ;;
  esac
  run "validate-metadata-$kind" --json registry validate-metadata "$metadata"
  run "validate-submission-$kind" --json registry validate-submission "$CLI_WORK_ROOT/submission-$kind.json"
  python3 - "$CLI_WORK_ROOT/logs/validate-metadata-$kind" "$CLI_WORK_ROOT/logs/validate-submission-$kind" <<'PY'
import json,pathlib,sys
for prefix in sys.argv[1:]:
 value=json.loads(pathlib.Path(prefix+'.out').read_text())
 assert value['ok'] is True and value['code']=='OK'
 assert pathlib.Path(prefix+'.err').read_text()==''
PY
  touch "$CLI_WORK_ROOT/logs/validate-metadata-$kind.passed" "$CLI_WORK_ROOT/logs/validate-submission-$kind.passed"
  for label in nested unknown provenance; do
    reject "reject-submission-$kind-$label" REGISTRY_VALIDATION_FAILED --json registry validate-submission "$CLI_WORK_ROOT/submission-$kind-$label.json"
  done
done
for label in nested malformed nonfinite; do
  reject "reject-metadata-$label" REGISTRY_VALIDATION_FAILED --json registry validate-metadata "$CLI_WORK_ROOT/$label/bad.json"
  reject "reject-submission-$label" REGISTRY_VALIDATION_FAILED --json registry validate-submission "$CLI_WORK_ROOT/$label/bad.json"
done
for label in link fifo oversized; do
  reject "reject-metadata-$label" REGISTRY_VALIDATION_FAILED --json registry validate-metadata "$CLI_WORK_ROOT/metadata-$label.json"
  reject "reject-expiry-$label" METADATA_EXPIRY_CHECK_FAILED --json registry check-metadata-expiry "$CLI_WORK_ROOT/expiry-$label.json"
done
reject reject-submission-oversized REGISTRY_VALIDATION_FAILED --json registry validate-submission "$CLI_WORK_ROOT/submission-oversized.json"
reject reject-expiry-malformed METADATA_EXPIRY_CHECK_FAILED --json registry check-metadata-expiry "$CLI_WORK_ROOT/malformed/bad.json"
# Unhealthy expiry emits a stdout report AND a stderr diagnostic; not reject().
for state in expired renewal-due healthy; do
  for mode in human json; do
    name="expiry-$state-$mode"
    result=0
    if [ "$mode" = json ]; then
      run "$name" --json registry check-metadata-expiry "$CLI_WORK_ROOT/expiry-$state.json" || result=$?
    else
      run "$name" registry check-metadata-expiry "$CLI_WORK_ROOT/expiry-$state.json" || result=$?
    fi
    python3 - "$CLI_WORK_ROOT/logs/$name" "$state" "$mode" "$result" <<'PY'
import json,pathlib,sys
prefix,state,mode,code=sys.argv[1:]
report=json.loads(pathlib.Path(prefix+'.out').read_text())
assert report['diagnostic_only'] is True and len(report['results'])==1
entry=report['results'][0]
assert entry['status']==state and entry['authenticated'] is False
assert isinstance(entry['remaining_hours'],(int,float))
stderr=pathlib.Path(prefix+'.err').read_text()
if state=='healthy':
 assert code=='0' and stderr==''
else:
 assert code=='1'
 if mode=='json':
  diagnostic=json.loads(stderr)
  assert diagnostic['ok'] is False and diagnostic['code']=='METADATA_RENEWAL_DUE'
 else: assert 'METADATA_RENEWAL_DUE' in stderr
PY
    touch "$CLI_WORK_ROOT/logs/$name.passed"
  done
done
run validate-provider-folder plugin validate "$CLI_WORK_ROOT/provider" --descriptor "$CLI_WORK_ROOT/qualification.json"
run validate-contributions registry validate --base "$CLI_WORK_ROOT/base" --candidate "$CLI_WORK_ROOT/candidate"
run validate-tab plugin validate "$CLI_WORK_ROOT/qualification-tab" --kind tab
run validate-theme plugin validate "$CLI_WORK_ROOT/theme" --kind theme
reject reject-theme-nonfinite-color THEME_VALIDATION_FAILED --json plugin validate "$CLI_WORK_ROOT/invalid-theme" --kind theme
for n in 1 2; do
  run "pack-provider-$n" registry pack-provider --package "$CLI_WORK_ROOT/provider-package.json" --target darwin-aarch64 --directory "$CLI_WORK_ROOT/provider" --output "$CLI_WORK_ROOT/provider-$n.tar.gz"
  run "pack-theme-$n" registry pack-theme --directory "$CLI_WORK_ROOT/theme" --output "$CLI_WORK_ROOT/theme-$n.tar.gz"
  run "pack-tab-$n" registry pack-tab --directory "$CLI_WORK_ROOT/qualification-tab" --package "$CLI_WORK_ROOT/tab-package.json" --output "$CLI_WORK_ROOT/tab-$n.tar.gz"
done
cmp "$CLI_WORK_ROOT/tab-1.tar.gz" "$CLI_WORK_ROOT/tab-2.tar.gz"
for field in id name version api_version unknown nested malformed-envelope; do
  reject "reject-tab-$field" TAB_PACKAGING_FAILED --json registry pack-tab --directory "$CLI_WORK_ROOT/qualification-tab" --package "$CLI_WORK_ROOT/tab-wrong-$field.json" --output "$CLI_WORK_ROOT/rejected-tab-$field.tar.gz"
  test ! -e "$CLI_WORK_ROOT/rejected-tab-$field.tar.gz"
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
if e['signed']['schema_version']!=2 or len(e['signed']['packages'])!=3 or {p.get('kind') for p in e['signed']['packages']}!={'provider','theme','tab'}: raise SystemExit('mixed catalog assertion failed')
p=json.loads((r/'signed-policy.json').read_text())
# Preserve a well-shaped policy while changing authenticated bytes.
p['signed']['generated_at']=(datetime.datetime.fromisoformat(p['signed']['generated_at'].replace('Z','+00:00'))+datetime.timedelta(seconds=1)).isoformat().replace('+00:00','Z')
(r/'tampered-policy.json').write_text(json.dumps(p))
PY
reject reject-signed-policy-tampering REGISTRY_VERIFICATION_FAILED --json registry verify-theme-blocklist --index "$CLI_WORK_ROOT/tampered-policy.json" --public-key "$CLI_WORK_ROOT/keys/public.pem" --key-id qualification-only
. "$SCRIPT_ROOT/qualify-native-tab.sh"
status=passed
