#!/bin/sh
# Read-only qualification CONTRACT preflight, not public lifecycle qualification.
# Fetch CLI first with tooling/marketplace-registry/scripts/ci/fetch-released-cli.sh
# scripts/cli-qualification.env <new-owned-output-dir>. No implicit download here.
set -eu
[ "$#" -eq 1 ] && [ "$1" = preflight ] || {
  echo 'only preflight is implemented; publication/resume/replay/renewal remain blocked' >&2
  exit 2
}
# This entry point has no write authority. Do not inherit credentials into the ELF.
[ -z "${CADENCR_REGISTRY_GITHUB_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ] || {
  echo 'credentials forbidden in read-only preflight' >&2; exit 2;
}
SCRIPT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
export SCRIPT_ROOT
python3 - <<'PY'
import hashlib, json, math, os, pathlib, re, stat, subprocess

def fail(message):
    raise SystemExit(message)

def required(name):
    value = os.environ.get(name, '')
    if not value:
        fail(name + ' is required')
    return value

def regular(value, label, limit):
    p = pathlib.Path(value)
    if not p.is_absolute() or str(p.resolve()) != str(p) or p.is_symlink() or not p.is_file():
        fail(label + ' must be an absolute canonical regular non-symlink file')
    if p.stat().st_size > limit:
        fail(label + ' exceeds size limit')
    return p

def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('duplicate request field')
        result[key] = value
    return result

def finite_number(text):
    value = float(text)
    if not math.isfinite(value):
        fail('nonfinite request or submission value')
    return value

repository = required('QA_REPOSITORY')
source = required('QA_SOURCE_REPOSITORY')
pattern = r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]+'
for value in (repository, source):
    if not re.fullmatch(pattern, value) or value.endswith('.git'):
        fail('scratch repository must be explicit owner/repository')
    if value.lower() in ('merkr-software/cadencr-registry', 'merkr-software/cadencr'):
        fail('production repository forbidden')
if source.lower() == repository.lower():
    fail('source and registry scratch repositories must be distinct')
if required('QA_CONFIRM_TARGETS') != repository + '\n' + source:
    fail('scratch target confirmation mismatch')
commit = required('QA_REGISTRY_COMMIT')
if not re.fullmatch(r'[0-9a-f]{40}', commit):
    fail('registry commit must be exact lowercase 40-character SHA')
expected = required('QA_REQUEST_SHA256')
if not re.fullmatch(r'[0-9a-f]{64}', expected):
    fail('request digest must be exact lowercase SHA-256')
request = regular(required('QA_REQUEST'), 'request', 1024 * 1024)
raw = request.read_bytes()
if hashlib.sha256(raw).hexdigest() != expected:
    fail('reviewed request digest mismatch')
try:
    value = json.loads(raw, object_pairs_hook=object_pairs, parse_float=finite_number,
                       parse_constant=lambda _: fail('nonfinite request value'))
except (ValueError, UnicodeError):
    fail('request must be valid JSON')
if not isinstance(value, dict) or value.get('schema_version') != 2 or value.get('repository') != repository:
    fail('request must target reviewed scratch repository with schema version 2')
# Only bind reviewed inputs here; Rust owns semantic publication validation.
if not isinstance(value.get('publications'), list) or not value['publications']:
    fail('bootstrap preflight requires reviewed publications; renewal is not implemented')
if value.get('previous_index') != 'bootstrap':
    fail('only bootstrap request contract is implemented')
for entry in value['publications']:
    if not isinstance(entry, dict) or not isinstance(entry.get('submission'), str):
        fail('publication submission path required')
    relative = pathlib.Path(entry['submission'])
    if relative.is_absolute() or '..' in relative.parts:
        fail('submission must remain inside reviewed request directory')
    submission = regular(str(request.parent / relative), 'submission', 1024 * 1024)
    try:
        document = json.loads(submission.read_bytes(), object_pairs_hook=object_pairs, parse_float=finite_number,
                              parse_constant=lambda _: fail('nonfinite submission value'))
    except (ValueError, UnicodeError):
        fail('submission must be valid JSON')
    provenance = document.get('source') if isinstance(document, dict) else None
    if not isinstance(provenance, dict) or provenance.get('repository') != 'https://github.com/' + source:
        fail('submission must bind reviewed scratch source repository')
private = regular(required('QA_PRIVATE_KEY'), 'private key', 16 * 1024)
if stat.S_IMODE(private.stat().st_mode) & 0o077:
    fail('qualification private key must have no group or other permissions')
cli = regular(required('CLI'), 'CLI', 134217728)
pins = (pathlib.Path(os.environ['SCRIPT_ROOT']) / 'cli-qualification.env').read_text()
expected_pins = ['CADENCR_RELEASE_VERSION=0.13.0',
                 'CADENCR_RELEASE_SHA256=d3223e3b3ff74543595fd3354c3249f50fa01def65f376a624eb1fbc8072df2a']
if [line for line in pins.splitlines() if line and not line.startswith('#')] != expected_pins:
    fail('unexpected qualification pins')
with cli.open('rb') as binary:
    if hashlib.file_digest(binary, 'sha256').hexdigest() != expected_pins[1].split('=')[1]:
        fail('CLI digest mismatch')
with cli.open('rb') as binary:
    if binary.read(4) != b'\x7fELF' or not os.access(cli, os.X_OK):
        fail('CLI must be executable ELF')
try:
    # Bounded output, deadline, and no credentials/configuration inherited by CLI.
    result = subprocess.run(['timeout', '--kill-after=2s', '30s', 'sh', '-c',
        '("$1" --version 2>/dev/null; printf "\\nstatus:%s\\n" "$?") | head -c 1025',
        'sh', str(cli)], capture_output=True, timeout=35,
        env={'PATH': os.environ['PATH'], 'HOME': '/nonexistent'})
except (OSError, subprocess.TimeoutExpired):
    fail('CLI version check failed')
if result.returncode != 0 or result.stdout != b'cadencr 0.13.0\n\nstatus:0\n':
    fail('CLI version mismatch or failed version check')
print(json.dumps({'schema_version': 1, 'qualification': 'github-contract-preflight',
    'status': 'incomplete', 'lifecycle_qualified': False, 'semantic_preflight': 'pending',
    'remote_verification': 'pending', 'public_publication': 'pending',
    'interruption_resume': 'pending', 'fresh_runner_recovery': 'pending', 'renewal': 'pending',
    'production_pins_changed': False, 'cli_version': '0.13.0',
    'cli_sha256': expected_pins[1].split('=')[1], 'request_sha256': expected}))
# Exit 3 means contract checked, not qualification passed.
raise SystemExit(3)
PY
