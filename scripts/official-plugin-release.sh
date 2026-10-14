#!/bin/sh
# Preparation only. No source CLI fallback, signing keys, or publication authority.
set -eu
mode=production
if [ "${1:-}" = --qualification ]; then mode=qualification; shift; fi
export mode
[ "$#" -eq 4 ] || { echo 'usage: official-plugin-release.sh [--qualification] <source-repo> <commit> <tag> <new-output>' >&2; exit 2; }
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
export ROOT
python3 - "$@" <<'PY'
import hashlib, json, os, pathlib, re, subprocess, sys, tempfile
repo, commit, tag, output = sys.argv[1:]
def fail(message): raise SystemExit(message)
def git(*args):
    return subprocess.check_output(['git', '-C', repo, *args], stderr=subprocess.DEVNULL)
if not re.fullmatch('[0-9a-f]{40}', commit): fail('full source commit required')
repository = 'merkr-software/CadencR'
origin = git('remote', 'get-url', 'origin').decode().strip()
if origin not in ('https://github.com/' + repository, 'https://github.com/' + repository + '.git', 'git@github.com:' + repository + '.git'): fail('unexpected source repository')
if os.environ['mode'] == 'production':
    if os.environ.get('GITHUB_REPOSITORY') != repository or os.environ.get('GITHUB_SHA') != commit or os.environ.get('GITHUB_REF') != 'refs/tags/' + tag: fail('production requires matching authoritative GitHub tag context')
match = re.fullmatch(r'plugins/(provider-pi|theme-(graphite|ember|fjord))/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag)
if not match: fail('invalid official plugin tag')
plugin, theme = match.group(1, 2)
version = tag.rsplit('/v', 1)[1]
if git('rev-parse', '--verify', commit + '^{commit}').decode().strip() != commit: fail('source commit mismatch')
# Require the real namespaced tag to exist and resolve to the exact source commit.
if git('rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}').decode().strip() != commit: fail('tag source mismatch')
def source(path):
    mode = git('ls-tree', commit, '--', path).decode().split()[0]
    if mode != '100644': fail('source must be regular tracked file')
    return git('show', commit + ':' + path)
policy = json.loads(source('plugins/release-policy.json'))
if policy.get('schema_version') != 1 or policy.get('publication') != 'PENDING': fail('unreviewed release policy')
if theme:
    path = 'plugins/themes/' + theme
    if policy.get('themes', {}).get(theme) != version: fail('source theme version mismatch')
    payload = source(path + '/theme.json')
    source('plugins/themes/LICENSE')
else:
    path = 'plugins/providers/pi'
    if json.loads(source(path + '/package.json'))['version'] != version: fail('source provider version mismatch')
    fail('Pi native targets, package metadata and conformance are PENDING')
out = pathlib.Path(output)
if not out.is_absolute() or out.exists() or out.is_symlink() or out.parent.resolve() != out.parent: fail('output must be new absolute canonical path')
root = pathlib.Path(os.environ['ROOT'])
# Only the production pin can authorize packaging; qualification pins are not consulted.
# Retain private scratch: recursive cleanup could delete an unexpected database.
work = pathlib.Path(tempfile.mkdtemp(prefix='official-plugin-'))
print('Private preparation scratch retained: ' + str(work), file=sys.stderr)
bootstrap_env = {'PATH':os.environ['PATH'], 'HOME':str(work)}
cli = subprocess.check_output(['sh', str(root/'tooling/marketplace-registry/scripts/ci/fetch-released-cli.sh'), str(root/('scripts/cli-qualification.env' if os.environ['mode'] == 'qualification' else 'tooling/marketplace-registry/ci/released-cli.env')), str(work/'cli')], env=bootstrap_env, timeout=300).decode().strip()
stage = work/'stage'; stage.mkdir(); (stage/'theme.json').write_bytes(payload)
home = work/'home'; home.mkdir()
env = {'PATH':os.environ['PATH'], 'HOME':str(home)}
def run(*args):
    return subprocess.check_output([cli, *args], env=env, timeout=60)
run('plugin', 'validate', str(stage), '--kind', 'theme')
archive = work/'first.tar.gz'; second = work/'second.tar.gz'
receipts = []
for destination in (archive, second):
    receipt = json.loads(run('registry', 'pack-theme', '--directory', str(stage), '--output', str(destination)))
    data = destination.read_bytes()
    if receipt != {'kind':'theme','archive':str(destination),'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)}: fail('packaging receipt mismatch')
    receipts.append(data)
if receipts[0] != receipts[1]: fail('nondeterministic canonical packaging')
name = plugin + '-' + version + '.tar.gz'
digest = hashlib.sha256(receipts[0]).hexdigest()
# Public payload is built from an allowlist, never CLI logs/paths or environment.
metadata = {'schema_version':1,'plugin':plugin,'version':version,'source_repository':repository,'source_commit':commit,'source_path':path,'tag':tag,'archive':name,'sha256':digest,'size':len(receipts[0]),'publication':'PENDING','authority':os.environ['mode']}
out.mkdir(mode=0o700)
(out/name).write_bytes(receipts[0])
(out/'SHA256SUMS').write_text(digest + '  ' + name + '\n')
(out/'release.json').write_text(json.dumps(metadata, sort_keys=True, indent=2)+'\n')
PY
