#!/bin/sh
# Read-only activation gate. Deliberately has no CLI download or publication path.
set -eu
[ "$#" -eq 2 ] || { echo 'AUTHOR_INPUT_INVALID' >&2; exit 2; }
export AUTHOR_SOURCE_COMMIT="$1" AUTHOR_REQUEST_SHA256="$2"
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
export ROOT
python3 - <<'PY'
import json, os, pathlib, re

def fail(code):
    raise SystemExit(code)

# Do not echo dispatch input, repository contents, paths, credentials or CLI output.
if os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch':
    fail('AUTHOR_CONTEXT_INVALID')
if os.environ.get('GITHUB_REPOSITORY') != 'merkr-software/CadencR':
    fail('AUTHOR_CONTEXT_INVALID')
if os.environ.get('GITHUB_REF') != 'refs/heads/main':
    fail('AUTHOR_CONTEXT_INVALID')
sha = os.environ.get('GITHUB_SHA', '')
workflow = os.environ.get('GITHUB_WORKFLOW_REF', '')
allowed_workflows = tuple('merkr-software/CadencR/.github/workflows/' + name + '@refs/heads/main'
                          for name in ('official-plugin-author.yml', 'cursor-provider-author.yml'))
if not re.fullmatch('[0-9a-f]{40}', sha) or workflow not in allowed_workflows:
    fail('AUTHOR_CONTEXT_INVALID')
if not re.fullmatch('[0-9a-f]{40}', os.environ['AUTHOR_SOURCE_COMMIT']) or not re.fullmatch('[0-9a-f]{64}', os.environ['AUTHOR_REQUEST_SHA256']):
    fail('AUTHOR_INPUT_INVALID')
root = pathlib.Path(os.environ['ROOT'])
try:
    policy = json.loads((root/'scripts/official-plugin-author-policy.json').read_bytes())
    release = json.loads((root/'plugins/release-policy.json').read_bytes())
except (OSError, ValueError):
    fail('AUTHOR_POLICY_INVALID')
if policy.get('schema_version') != 1 or policy.get('repository') != 'merkr-software/CadencR' or release.get('schema_version') != 2:
    fail('AUTHOR_POLICY_INVALID')
if policy.get('publication') != 'APPROVED' or release.get('publication') != 'APPROVED':
    fail('AUTHOR_PUBLICATION_PENDING')
for field in ('author_cli_sha256','author_cli_pin_sha256','author_cli_qualification_sha256'):
    if not re.fullmatch('[0-9a-f]{64}',policy.get(field,'')): fail('AUTHOR_POLICY_INVALID')
if type(policy.get('repository_id')) is not int or policy['repository_id'] <= 0 or not re.fullmatch('[A-Za-z0-9-]{1,39}',policy.get('author_account','')): fail('AUTHOR_POLICY_INVALID')
if type(policy.get('environment_id')) is not int or policy['environment_id'] <= 0 or policy.get('admin_bypass_reviewed_disabled') is not True: fail('AUTHOR_ENVIRONMENT_REVIEW_REQUIRED')
print('AUTHOR_ACTIVATION_APPROVED')
PY
