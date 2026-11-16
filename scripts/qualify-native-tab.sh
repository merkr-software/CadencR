#!/bin/sh
# Sourced only by qualify-released-cli.sh after exact-ELF verification.
# Fixtures are inert format headers, not programs. Never omit --no-run.
python3 - <<'PY'
import os,pathlib,json,struct,shutil
r=pathlib.Path(os.environ['CLI_WORK_ROOT'])
platforms=['darwin-aarch64','darwin-x86_64','linux-x86_64']
m=json.loads((r/'qualification-tab/tab.json').read_text())
m.update(id='native-tab',name='Qualification native tab')
m['backend']={'protocol':1,'reasoning':'Inert native packaging qualification; never execute.','binary':{p:f'bin/{p}/inert' for p in platforms}}
for folder in ['native-tab','native-web']:
 (r/folder/'dist').mkdir(parents=True)
 (r/folder/'tab.json').write_text(json.dumps(m))
 (r/folder/'dist/index.html').write_text('<!doctype html><title>Inert native tab fixture</title>')
for p in platforms:
 path=r/'native-tab'/m['backend']['binary'][p]; path.parent.mkdir(parents=True)
 # Same minimal format-only fixtures as plugin-core's native_executable tests.
 if p=='linux-x86_64':
  b=bytearray(64); b[:8]=b'\x7fELF\x02\x01\x01\x00'; struct.pack_into('<HHI',b,16,2,62,1)
 else:
  arm=p=='darwin-aarch64'; commands=[0x1b,24,0,0,0,0]+([0x1d,16,0,0] if arm else [])
  words=[0xfeedfacf,0x0100000c if arm else 0x01000007,0,2,2 if arm else 1,len(commands)*4,0,0]+commands
  b=struct.pack('<'+'I'*len(words),*words)
 path.write_bytes(b); path.chmod(0o755)
for label in ['protocol','target']:
 bad=json.loads(json.dumps(m))
 if label=='protocol': bad['backend']['protocol']=999
 else: bad['backend']['binary']['windows-x86_64']='bin/windows-x86_64/inert'
 d=r/('native-invalid-'+label); d.mkdir(); (d/'tab.json').write_text(json.dumps(bad))
PY
run validate-native-static plugin validate "$CLI_WORK_ROOT/native-tab" --kind tab --no-run
for target in darwin-aarch64 darwin-x86_64 linux-x86_64; do
  for n in 1 2; do
    run "pack-native-$target-$n" registry pack-tab-backend --directory "$CLI_WORK_ROOT/native-tab" --target "$target" --output "$CLI_WORK_ROOT/native-$target-$n.tar.gz"
  done
  cmp "$CLI_WORK_ROOT/native-$target-1.tar.gz" "$CLI_WORK_ROOT/native-$target-2.tar.gz"
done
# CLI usage failures are exit 2, not semantic exit 1.
if run reject-native-target --json registry pack-tab-backend --directory "$CLI_WORK_ROOT/native-tab" --target windows-x86_64 --output "$CLI_WORK_ROOT/rejected-native-target.tar.gz"; then exit 1; fi
test "$result" -eq 2
test ! -s "$CLI_WORK_ROOT/logs/reject-native-target.out"
python3 - <<'PY'
import os,pathlib,json
r=pathlib.Path(os.environ['CLI_WORK_ROOT'])
e=json.loads((r/'logs/reject-native-target.err').read_text())
assert e['ok'] is False and e['code']=='CLI_USAGE_ERROR'
assert not (r/'rejected-native-target.tar.gz').exists()
(r/'logs/reject-native-target.passed').touch()
PY
for label in protocol target; do
  reject "reject-native-manifest-$label" TAB_BACKEND_PACKAGING_FAILED --json registry pack-tab-backend --directory "$CLI_WORK_ROOT/native-invalid-$label" --target linux-x86_64 --output "$CLI_WORK_ROOT/rejected-native-$label.tar.gz"
  test ! -e "$CLI_WORK_ROOT/rejected-native-$label.tar.gz"
done
python3 - <<'PY'
import os,pathlib,json,hashlib,tarfile,copy
r=pathlib.Path(os.environ['CLI_WORK_ROOT'])
h=lambda b:hashlib.sha256(b).hexdigest()
p=json.loads((r/'tab-package.json').read_text()); t=p['package']['tab']
m=json.loads((r/'native-web/tab.json').read_text())
t.update(id=m['id'],name=m['name'],backend={k:m['backend'][k] for k in ['protocol','reasoning']})
t['distribution']['binary']={}
for platform,cmd in m['backend']['binary'].items():
 receipt=json.loads((r/f'logs/pack-native-{platform}-1.out').read_text())
 archive=r/f'native-{platform}-1.tar.gz'; executable=(r/'native-tab'/cmd).read_bytes()
 assert receipt['kind']=='tab-backend' and receipt['target']==platform and receipt['cmd']==cmd
 assert receipt['sha256']==h(archive.read_bytes()) and receipt['size']==archive.stat().st_size
 assert receipt['executable_sha256']==h(executable) and receipt['executable_size']==len(executable)
 with tarfile.open(archive,'r:gz') as tar:
  entries=tar.getmembers(); assert len(entries)==1 and entries[0].isfile()
  assert entries[0].name==cmd and entries[0].mode==0o755
  assert tar.extractfile(entries[0]).read()==executable
 t['distribution']['binary'][platform]={k:receipt[k] for k in ['sha256','size','cmd','executable_sha256','executable_size']}
 t['distribution']['binary'][platform]['archive']=f'https://github.com/acme/tabs/releases/download/v1.0.0/native-{platform}-1.tar.gz'
(r/'native-package.json').write_text(json.dumps(p))
for label in ['protocol','target','digest','reasoning','cmd','platforms']:
 bad=copy.deepcopy(p); tab=bad['package']['tab']; binary=tab['distribution']['binary']
 if label=='protocol': tab['backend']['protocol']=999
 elif label=='target': binary['windows-x86_64']=binary.pop('linux-x86_64')
 elif label=='digest': binary['linux-x86_64']['executable_sha256']='bad'
 elif label=='reasoning': tab['backend']['reasoning']='A different reason.'
 elif label=='cmd': binary['linux-x86_64']['cmd']='bin/linux-x86_64/different'
 else: del binary['darwin-x86_64']
 (r/f'native-wrong-{label}.json').write_text(json.dumps(bad))
submission={'schema_version':2,'package':p,'source':{'repository':t['repository'],'commit':'b'*40,'tag':'v1.0.0'},'changelog':'Inert cross-platform native qualification'}
(r/'native-submission.json').write_text(json.dumps(submission))
(r/'native-base/packages').mkdir(parents=True)
for folder in ['packages','submissions']: (r/'native-candidate'/folder).mkdir(parents=True)
(r/'native-candidate/packages/native-tab-1.0.0.json').write_text(json.dumps(p))
(r/'native-candidate/submissions/native-tab-1.0.0.json').write_text(json.dumps(submission))
PY
run validate-native-metadata --json registry validate-metadata "$CLI_WORK_ROOT/native-package.json"
run validate-native-submission --json registry validate-submission "$CLI_WORK_ROOT/native-submission.json"
run validate-native-contribution registry validate --base "$CLI_WORK_ROOT/native-base" --candidate "$CLI_WORK_ROOT/native-candidate"
for label in protocol target digest; do
  reject "reject-native-metadata-$label" REGISTRY_VALIDATION_FAILED --json registry validate-metadata "$CLI_WORK_ROOT/native-wrong-$label.json"
done
for n in 1 2; do
  run "pack-native-ui-$n" registry pack-tab --directory "$CLI_WORK_ROOT/native-web" --package "$CLI_WORK_ROOT/native-package.json" --output "$CLI_WORK_ROOT/native-ui-$n.tar.gz"
done
cmp "$CLI_WORK_ROOT/native-ui-1.tar.gz" "$CLI_WORK_ROOT/native-ui-2.tar.gz"
reject reject-native-embedded-binary TAB_PACKAGING_FAILED --json registry pack-tab --directory "$CLI_WORK_ROOT/native-tab" --package "$CLI_WORK_ROOT/native-package.json" --output "$CLI_WORK_ROOT/rejected-native-embedded.tar.gz"
for label in reasoning cmd platforms; do
  reject "reject-native-binding-$label" TAB_PACKAGING_FAILED --json registry pack-tab --directory "$CLI_WORK_ROOT/native-web" --package "$CLI_WORK_ROOT/native-wrong-$label.json" --output "$CLI_WORK_ROOT/rejected-native-binding-$label.tar.gz"
  test ! -e "$CLI_WORK_ROOT/rejected-native-binding-$label.tar.gz"
done
# The author CLI's local immutable-asset binding verifies exact archive bytes.
# This is NOT executable conformance or the installer's native archive validator.
python3 - <<'PY'
import os,pathlib,json,hashlib,shutil,tarfile
r=pathlib.Path(os.environ['CLI_WORK_ROOT'])
with tarfile.open(r/'native-ui-1.tar.gz','r:gz') as tar:
 names=tar.getnames(); assert set(names)=={'tab.json','dist/index.html'}
assets=['native-ui-1.tar.gz','native-package.json']+[f'native-{p}-1.tar.gz' for p in ['darwin-aarch64','darwin-x86_64','linux-x86_64']]
def asset(name):
 b=(r/name).read_bytes(); return {'name':name,'size':len(b),'sha256':hashlib.sha256(b).hexdigest()}
request={'schema_version':1,'repository':'acme/tabs','expected_repository_id':42,'expected_account':'qualification','tag':'v1.0.0','source_commit':'b'*40,'release_notes':'Inert local-only qualification','prerelease':False,'archive':asset(assets[0]),'metadata':asset(assets[1]),'additional_archives':[asset(n) for n in assets[2:]]}
(r/'native-author-request.json').write_text(json.dumps(request))
for label in ['archive','executable']:
 d=r/('native-tampered-'+label); d.mkdir()
 for name in assets: shutil.copyfile(r/name,d/name)
p=r/'native-tampered-archive/native-darwin-x86_64-1.tar.gz'
b=bytearray(p.read_bytes()); b[-1]^=1; p.write_bytes(b)
# Same native header and length, changed executable bytes; repack through the CLI.
d=r/'native-modified-executable'; shutil.copytree(r/'native-tab',d)
p=d/'bin/linux-x86_64/inert'; b=bytearray(p.read_bytes()); b[-1]^=1; p.write_bytes(b)
# Destination must be new: use a distinct name, then bind it to the old request.
PY
run inspect-native-author plugin inspect-release --request "$CLI_WORK_ROOT/native-author-request.json" --directory "$CLI_WORK_ROOT"
reject reject-native-archive-tampering AUTHOR_RELEASE_FAILED --json plugin inspect-release --request "$CLI_WORK_ROOT/native-author-request.json" --directory "$CLI_WORK_ROOT/native-tampered-archive"
run pack-native-modified-executable registry pack-tab-backend --directory "$CLI_WORK_ROOT/native-modified-executable" --target linux-x86_64 --output "$CLI_WORK_ROOT/native-modified.tar.gz"
python3 - <<'PY'
import os,pathlib,json,shutil
r=pathlib.Path(os.environ['CLI_WORK_ROOT'])
a=json.loads((r/'logs/pack-native-linux-x86_64-1.out').read_text())
b=json.loads((r/'logs/pack-native-modified-executable.out').read_text())
assert a['executable_size']==b['executable_size'] and a['executable_sha256']!=b['executable_sha256']
assert a['sha256']!=b['sha256']
shutil.copyfile(r/'native-modified.tar.gz',r/'native-tampered-executable/native-linux-x86_64-1.tar.gz')
receipt=json.loads((r/'logs/inspect-native-author.out').read_text())
assert receipt['ok'] is True and receipt['local_only'] is True
assert receipt['request']==json.loads((r/'native-author-request.json').read_text())
for name in ['validate-native-metadata','validate-native-submission']:
 receipt=json.loads((r/f'logs/{name}.out').read_text())
 assert receipt['ok'] is True and receipt['code']=='OK'
 assert (r/f'logs/{name}.err').read_text()==''
 (r/f'logs/{name}.passed').touch()
(r/'logs/inspect-native-author.passed').touch()
PY
reject reject-native-executable-tampering AUTHOR_RELEASE_FAILED --json plugin inspect-release --request "$CLI_WORK_ROOT/native-author-request.json" --directory "$CLI_WORK_ROOT/native-tampered-executable"
