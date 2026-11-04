#!/bin/sh
# Trusted-main orchestrator. Candidate Git objects are data, never executable.
set -eu
[ "$#" -eq 5 ] || { echo AUTHOR_INPUT_INVALID >&2; exit 2; }
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
export ROOT
python3 - "$@" <<'PY'
import hashlib, json, os, pathlib, re, subprocess, sys, urllib.request

def fail(code): raise SystemExit(code)
def digest(data): return hashlib.sha256(data).hexdigest()
def git(*args):
    return subprocess.check_output(['git', '-C', repo, *args], stderr=subprocess.DEVNULL, timeout=30)
def tracked(path):
    entry = git('ls-tree', commit, '--', path).decode().split()
    if not entry or entry[0] != '100644': fail('AUTHOR_SOURCE_INVALID')
    return git('show', commit + ':' + path)
repo, commit, tag, expected_digest, output = sys.argv[1:]
root = pathlib.Path(os.environ['ROOT'])
sys.path.insert(0, str(root/'scripts'))
from official_plugin_author_review import validate_review_policy, validate_remote_reviewers
from official_plugin_tags import release_tag, release_notes
if not re.fullmatch('[0-9a-f]{40}', commit) or not re.fullmatch('[0-9a-f]{64}', expected_digest): fail('AUTHOR_INPUT_INVALID')
try:
    policy = json.loads((root/'scripts/official-plugin-author-policy.json').read_bytes())
    release_bytes = (root/'plugins/release-policy.json').read_bytes()
    release = json.loads(release_bytes)
    if policy.get('publication') != 'APPROVED' or release.get('publication') != 'APPROVED': fail('AUTHOR_PUBLICATION_PENDING')
    if policy.get('repository') != 'merkr-software/CadencR' or type(policy.get('repository_id')) is not int or policy['repository_id'] <= 0: fail('AUTHOR_POLICY_INVALID')
    if not re.fullmatch('[A-Za-z0-9-]{1,39}', policy.get('author_account','')): fail('AUTHOR_POLICY_INVALID')
    for field in ('author_cli_sha256', 'author_cli_qualification_sha256'):
        if not re.fullmatch('[0-9a-f]{64}', policy.get(field,'')): fail('AUTHOR_POLICY_INVALID')
    evidence_bytes = (root/'scripts/official-plugin-author-qualification.json').read_bytes()
    evidence = json.loads(evidence_bytes)
    if digest(evidence_bytes) != policy['author_cli_qualification_sha256'] or evidence != {'schema_version':1,'author_release_contract':'QUALIFIED','cli_version':policy.get('author_cli_version'),'cli_sha256':policy['author_cli_sha256']}: fail('AUTHOR_QUALIFICATION_INVALID')
    pin = (root/'scripts/official-plugin-author-cli.env').read_bytes()
    if digest(pin) != policy.get('author_cli_pin_sha256'): fail('AUTHOR_POLICY_INVALID')
    if ('CADENCR_RELEASE_SHA256='+policy['author_cli_sha256']+'\n').encode() not in pin: fail('AUTHOR_POLICY_INVALID')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?',policy.get('author_cli_version','')) or ('CADENCR_RELEASE_VERSION='+policy['author_cli_version']+'\n').encode() not in pin: fail('AUTHOR_POLICY_INVALID')
    if tracked('plugins/release-policy.json') != release_bytes: fail('AUTHOR_POLICY_MISMATCH')
    try: plugin, version = release_tag(tag, release)
    except ValueError: fail('AUTHOR_TAG_INVALID')
    entry = release.get('plugins',{}).get(plugin)
    if release.get('schema_version') != 2 or not isinstance(entry,dict) or entry.get('version') != version or entry.get('preparation') != 'READY': fail('AUTHOR_PLUGIN_UNAPPROVED')
    notes = release_notes(entry, tag)
    if git('rev-parse','--verify', 'refs/tags/'+tag+'^{commit}').decode().strip() != commit: fail('AUTHOR_TAG_INVALID')
    # Numeric repository identity is checked independently of origin spelling.
    url = 'https://api.github.com/repos/'+policy['repository']
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    opener = urllib.request.build_opener(NoRedirect)
    def api(path):
        headers = {'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
        token = os.environ.get('AUTHOR_READ_TOKEN')
        if token: headers['Authorization'] = 'Bearer '+token
        with opener.open(urllib.request.Request(url+path,headers=headers),timeout=30) as response:
            body = response.read(1048577)
        if len(body) > 1048576: fail('AUTHOR_REMOTE_INVALID')
        return json.loads(body)
    remote = api('')
    if remote.get('id') != policy['repository_id'] or remote.get('full_name') != policy['repository']: fail('AUTHOR_REPOSITORY_INVALID')
    reviewed = validate_review_policy(policy.get('environment_review_policy'), policy.get('environment_id'))
    protected = api('/environments/official-plugin-publication')
    rules = protected.get('protection_rules',[])
    reviewers = [r for r in rules if r.get('type') == 'required_reviewers']
    if type(policy.get('environment_id')) is not int or policy['environment_id'] <= 0 or type(protected.get('id')) is not int or protected.get('id') != policy['environment_id']: fail('AUTHOR_ENVIRONMENT_ID_MISMATCH')
    # GitHub's documented response omits this setting. In that case only an
    # explicit reviewed no-bypass attestation bound to this environment ID is
    # accepted; this is NOT runtime introspection of the admin-bypass setting.
    if 'can_admins_bypass' in protected:
        if protected['can_admins_bypass'] is not False: fail('AUTHOR_ENVIRONMENT_UNPROTECTED')
    elif policy.get('admin_bypass_reviewed_disabled') is not True:
        fail('AUTHOR_ENVIRONMENT_REVIEW_REQUIRED')
    validate_remote_reviewers(reviewers, reviewed)
    branches = protected.get('deployment_branch_policy',{})
    if branches != {'protected_branches':False,'custom_branch_policies':True}: fail('AUTHOR_ENVIRONMENT_UNPROTECTED')
    branch_rules = api('/environments/official-plugin-publication/deployment-branch-policies?per_page=100')
    entries = branch_rules.get('branch_policies',[])
    if branch_rules.get('total_count') != 1 or len(entries) != 1 or entries[0].get('name') != 'main' or entries[0].get('type') != 'branch': fail('AUTHOR_ENVIRONMENT_UNPROTECTED')
    out = pathlib.Path(output)
    if not out.is_absolute() or out.exists() or out.is_symlink() or out.parent.resolve() != out.parent: fail('AUTHOR_OUTPUT_INVALID')
    env = dict(os.environ)
    # Trusted main script reads candidate Git blobs; no candidate build/script runs.
    subprocess.run(['sh',str(root/'scripts/official-plugin-release.sh'),'--author-approved',repo,commit,tag,output],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=600)
    metadata = json.loads((out/'release.json').read_bytes())
    def asset(name):
        if not isinstance(name,str) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,199}',name) or name in ('.','..'): fail('AUTHOR_ASSET_INVALID')
        payload = (out/name).read_bytes()
        return {'name':name,'size':len(payload),'sha256':digest(payload)}
    archives = metadata.get('archives')
    if metadata.get('schema_version') != 2 or not isinstance(archives,list) or not archives: fail('AUTHOR_ASSET_INVALID')
    names = [item['name'] for item in archives]
    if len(names) != len(set(names)): fail('AUTHOR_ASSET_INVALID')
    for item in archives:
        bound = asset(item['name'])
        if bound['size'] != item['size'] or bound['sha256'] != item['sha256']: fail('AUTHOR_ASSET_INVALID')
    package = asset('package.json')
    if metadata.get('package') != package: fail('AUTHOR_ASSET_INVALID')
    allowed = set(names + ['package.json','submission.json','release.json','SHA256SUMS'])
    if {path.name for path in out.iterdir()} != allowed: fail('AUTHOR_EXTRA_CONTENT')
    request = {'schema_version':1,'repository':policy['repository'],'expected_repository_id':policy['repository_id'],'expected_account':policy['author_account'],'tag':tag,'source_commit':commit,'release_notes':notes,'prerelease':False,'archive':asset(names[0]),'metadata':package,'additional_archives':[asset(name) for name in names[1:]]}
    data = (json.dumps(request,sort_keys=True,separators=(',',':'))+'\n').encode()
    actual = digest(data)
    if expected_digest != '0'*64 and actual != expected_digest: fail('AUTHOR_REQUEST_DIGEST_MISMATCH')
    (out/'request.json').write_bytes(data)
    print(actual)
except Exception:
    fail('AUTHOR_STAGE_FAILED')
PY
