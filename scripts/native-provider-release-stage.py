"""Trusted-main author orchestration for compiled provider artifacts.

Build jobs have no publication credential. Here payloads stay inert: bind the
successful native build run, source/tag, protected environment, exact file
digests and request before the separate protected job loads its author token.
"""
import argparse
import os
import pathlib
import re
import subprocess
import tempfile

from official_plugin_author_review import validate_review_policy, validate_remote_reviewers
from official_plugin_pack import REPOSITORY, digest, parse_json
from native_provider_release_prepare import PROVIDERS, TARGETS, prepare, require, version_at

ROOT = pathlib.Path(__file__).resolve().parent.parent
NATIVE_BUILD_WORKFLOW = ".github/workflows/cursor-provider-build.yml"


def api(path):
    return parse_json(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}{path}"], timeout=60))


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
    provider = PROVIDERS[args.provider]
    subprocess.run(["sh", str(ROOT / "scripts/official-plugin-author-gate.sh"),
                    args.source_commit, args.request_sha256], check=True, timeout=30)
    policy = parse_json((ROOT / "scripts/official-plugin-author-policy.json").read_bytes())
    qualification = (ROOT / "scripts/official-plugin-author-qualification.json").read_bytes()
    require(digest(qualification) == policy["author_cli_qualification_sha256"] and
            parse_json(qualification) == {"schema_version": 1, "author_release_contract": "QUALIFIED",
                "cli_version": policy["author_cli_version"], "cli_sha256": policy["author_cli_sha256"]},
            "author CLI qualification mismatch")
    pin = (ROOT / "scripts/official-plugin-author-cli.env").read_bytes()
    require(digest(pin) == policy["author_cli_pin_sha256"], "author CLI pin review mismatch")
    environment(policy)
    require(args.source_repo.resolve() == ROOT, "source objects must come from the trusted checkout")
    head = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], timeout=30).decode().strip()
    require(head == os.environ.get("GITHUB_SHA"), "trusted checkout does not match workflow commit")
    source = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--verify",
                                     f"{args.source_commit}^{{commit}}"], timeout=30).decode().strip()
    require(source == args.source_commit, "source object mismatch")
    subprocess.run(["git", "-C", str(args.source_repo), "merge-base", "--is-ancestor",
                    args.source_commit, "HEAD"], check=True, timeout=30)
    tag = provider.tag(version_at(args.source_repo, args.source_commit, provider))
    tagged = subprocess.check_output(["git", "-C", str(args.source_repo), "rev-parse", "--verify",
                                      f"refs/tags/{tag}^{{commit}}"], timeout=30).decode().strip()
    require(tagged == args.source_commit, "provider tag source mismatch")
    return policy


def download(args, policy, directory):
    provider = PROVIDERS[args.provider]
    run = api(f"/actions/runs/{args.build_run}")
    require(run.get("head_sha") == args.source_commit and run.get("status") == "completed" and
            run.get("conclusion") == "success" and run.get("path") == NATIVE_BUILD_WORKFLOW and
            run.get("event") in ("push", "workflow_dispatch") and
            run.get("repository", {}).get("id") == policy["repository_id"] and
            run.get("head_repository", {}).get("id") == policy["repository_id"], "native build provenance mismatch")
    listing = api(f"/actions/runs/{args.build_run}/artifacts?per_page=100")
    all_artifacts = listing.get("artifacts", [])
    require(listing.get("total_count") == len(all_artifacts) and len(all_artifacts) <= 8,
            "ambiguous artifact listing")
    artifacts = [artifact for artifact in all_artifacts if artifact.get("name", "").startswith(f"{provider.id}-native-")]
    expected = {f"{provider.id}-native-{target}-{args.source_commit}" for target in TARGETS}
    require(len(artifacts) == len(expected) and
            {artifact.get("name") for artifact in artifacts} == expected and
            all(artifact.get("expired") is False and 0 < artifact.get("size_in_bytes", 0) <= 40 * 1024 * 1024
                for artifact in artifacts), "native build artifacts missing, expired, oversized or ambiguous")
    command = ["gh", "run", "download", args.build_run, "--repo", REPOSITORY, "--dir", str(directory)]
    for name in sorted(expected):
        command.extend(["--name", name])
    subprocess.run(command, check=True, timeout=480)


def stage(args):
    policy = validate_context(args)
    scratch = pathlib.Path(tempfile.mkdtemp(prefix=f"{args.provider}-author-"))
    print(f"Private author scratch retained: {scratch}")
    payloads = scratch / "payloads"
    payloads.mkdir()
    download(args, policy, payloads)
    cli = pathlib.Path(subprocess.check_output(["sh", str(ROOT / "tooling/marketplace-registry/scripts/ci/fetch-released-cli.sh"),
                       str(ROOT / "scripts/official-plugin-author-cli.env"), str(args.cli_directory)],
                       timeout=300).decode().strip())
    require(digest(cli.read_bytes()) == policy["author_cli_sha256"], "author CLI pin mismatch")
    package_args = argparse.Namespace(provider=args.provider, input=payloads, output=args.output,
                                      source_repo=args.source_repo, source_commit=args.source_commit, cli=cli)
    actual = prepare(package_args)
    require(args.request_sha256 == "0" * 64 or actual == args.request_sha256, "author request digest mismatch")
    subprocess.run([str(cli), "plugin", "inspect-release", "--request", str(args.output / "request.json"),
                    "--directory", str(args.output)], check=True, stdout=subprocess.DEVNULL, timeout=60)
    print(f"Request SHA-256: {actual}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as output:
            output.write(f"`{args.provider}` request SHA-256: `{actual}`\n\n"
                         f"Source: `{args.source_commit}`; native build run: `{args.build_run}`.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=PROVIDERS, required=True)
    parser.add_argument("--source-repo", required=True, type=pathlib.Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--build-run", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--cli-directory", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    stage(parser.parse_args())
