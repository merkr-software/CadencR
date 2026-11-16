"""Trusted-main author orchestration for compiled Cursor artifacts.

Build jobs have no publication credential. Here payloads stay inert: bind the
successful native build run, source/tag, protected environment, exact file
digests and request before the separate protected job loads its author token.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile

from official_plugin_author_review import validate_review_policy, validate_remote_reviewers
from cursor_release_prepare import TARGETS, prepare, require

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPOSITORY = "merkr-software/CadencR"


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}{path}"], timeout=60))


def environment(policy):
    remote = api("")
    require(remote.get("id") == policy["repository_id"] and remote.get("full_name") == REPOSITORY,
            "author repository identity mismatch")
    protected = api("/environments/official-plugin-publication")
    require(protected.get("id") == policy["environment_id"], "author environment identity mismatch")
    if "can_admins_bypass" in protected:
        require(protected["can_admins_bypass"] is False, "author environment allows bypass")
    else:
        require(policy.get("admin_bypass_reviewed_disabled") is True, "environment review required")
    reviewed = validate_review_policy(policy["environment_review_policy"], policy["environment_id"])
    rules = [rule for rule in protected.get("protection_rules", []) if rule.get("type") == "required_reviewers"]
    validate_remote_reviewers(rules, reviewed)
    require(protected.get("deployment_branch_policy") == {"protected_branches": False, "custom_branch_policies": True},
            "author environment branch protection mismatch")
    branches = api("/environments/official-plugin-publication/deployment-branch-policies?per_page=100")
    entries = branches.get("branch_policies", [])
    require(branches.get("total_count") == 1 and len(entries) == 1 and
            entries[0].get("name") == "main" and entries[0].get("type") == "branch", "author environment must require main")


def validate_context(args):
    require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and
            os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and
            os.environ.get("GITHUB_REF") == "refs/heads/main" and
            os.environ.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/.github/workflows/cursor-provider-author.yml@refs/heads/main",
            "compiled author release requires trusted main dispatch")
    require(re.fullmatch("[0-9a-f]{40}", args.source_commit), "invalid source commit")
    require(re.fullmatch("[1-9][0-9]{0,19}", args.build_run), "invalid native build run")
    require(re.fullmatch("[0-9a-f]{64}", args.request_sha256), "invalid request digest")
    subprocess.run(["sh", str(ROOT / "scripts/official-plugin-author-gate.sh"),
                    args.source_commit, args.request_sha256], check=True, timeout=30)
    policy = json.loads((ROOT / "scripts/official-plugin-author-policy.json").read_bytes())
    qualification = (ROOT / "scripts/official-plugin-author-qualification.json").read_bytes()
    require(hashlib.sha256(qualification).hexdigest() == policy["author_cli_qualification_sha256"] and
            json.loads(qualification) == {"schema_version": 1, "author_release_contract": "QUALIFIED",
                "cli_version": policy["author_cli_version"], "cli_sha256": policy["author_cli_sha256"]},
            "author CLI qualification mismatch")
    pin = (ROOT / "scripts/official-plugin-author-cli.env").read_bytes()
    require(hashlib.sha256(pin).hexdigest() == policy["author_cli_pin_sha256"], "author CLI pin review mismatch")
    environment(policy)
    require(args.source_repo.resolve() == ROOT, "source objects must come from the trusted checkout")
    head = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], timeout=30).decode().strip()
    require(head == os.environ.get("GITHUB_SHA"), "trusted checkout does not match workflow commit")
    source = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--verify",
                                     f"{args.source_commit}^{{commit}}"], timeout=30).decode().strip()
    require(source == args.source_commit, "source object mismatch")
    subprocess.run(["git", "-C", str(args.source_repo), "merge-base", "--is-ancestor",
                    args.source_commit, "HEAD"], check=True, timeout=30)
    version = json.loads(subprocess.check_output(["git", "-C", str(args.source_repo), "show",
                        f"{args.source_commit}:plugins/providers/cursor/package.json"], timeout=30))["version"]
    require(re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version), "invalid Cursor version")
    tag = f"plugins/provider-cursor/v{version}"
    tagged = subprocess.check_output(["git", "-C", str(args.source_repo), "rev-parse", "--verify",
                                      f"refs/tags/{tag}^{{commit}}"], timeout=30).decode().strip()
    require(tagged == args.source_commit, "Cursor tag source mismatch")
    return policy


def download(args, policy, directory):
    run = api(f"/actions/runs/{args.build_run}")
    require(run.get("head_sha") == args.source_commit and run.get("status") == "completed" and
            run.get("conclusion") == "success" and run.get("path") == ".github/workflows/cursor-provider-build.yml" and
            run.get("event") in ("push", "workflow_dispatch") and
            run.get("repository", {}).get("id") == policy["repository_id"] and
            run.get("head_repository", {}).get("id") == policy["repository_id"], "native build provenance mismatch")
    listing = api(f"/actions/runs/{args.build_run}/artifacts?per_page=100")
    all_artifacts = listing.get("artifacts", [])
    require(listing.get("total_count") == len(all_artifacts) and len(all_artifacts) <= 8,
            "ambiguous artifact listing")
    artifacts = [artifact for artifact in all_artifacts if artifact.get("name", "").startswith("cursor-native-")]
    expected = {f"cursor-native-{target}-{args.source_commit}" for target in TARGETS}
    require(len(artifacts) == 4 and
            {artifact.get("name") for artifact in artifacts} == expected and
            all(artifact.get("expired") is False and 0 < artifact.get("size_in_bytes", 0) <= 40 * 1024 * 1024
                for artifact in artifacts), "native build artifacts missing, expired, oversized or ambiguous")
    for name in sorted(expected):
        subprocess.run(["gh", "run", "download", args.build_run, "--repo", REPOSITORY,
                        "--name", name, "--dir", str(directory / name)], check=True, timeout=120)


def stage(args):
    policy = validate_context(args)
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="cursor-author-"))
    print(f"Private author scratch retained: {scratch}")
    payloads = scratch / "payloads"
    payloads.mkdir()
    download(args, policy, payloads)
    cli_dir = scratch / "cli"
    cli = pathlib.Path(subprocess.check_output(["sh", str(ROOT / "tooling/marketplace-registry/scripts/ci/fetch-released-cli.sh"),
                       str(ROOT / "scripts/official-plugin-author-cli.env"), str(cli_dir)], timeout=300).decode().strip())
    require(hashlib.sha256(cli.read_bytes()).hexdigest() == policy["author_cli_sha256"], "author CLI pin mismatch")
    package_args = argparse.Namespace(input=payloads, output=args.output, source_repo=args.source_repo,
                                      source_commit=args.source_commit, cli=cli)
    actual = prepare(package_args)
    require(args.request_sha256 == "0" * 64 or actual == args.request_sha256, "author request digest mismatch")
    print(f"Request SHA-256: {actual}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as output:
            output.write(f"Cursor request SHA-256: `{actual}`\n\nSource: `{args.source_commit}`; native build run: `{args.build_run}`.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-repo", required=True, type=pathlib.Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--build-run", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    stage(parser.parse_args())
