#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "desktop-release-workflow.test: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="$repo_root/.github/workflows/desktop-release.yml"
[ -f "$workflow" ] || fail "missing workflow: $workflow"

workflow_text="$(cat "$workflow")"
cli_job_text="$(sed -n '/^  cli-linux:/,/^  release:/p' "$workflow")"

case "$workflow_text" in
  *"--publish always"*)
    fail "desktop release workflow must not let electron-builder publish directly"
    ;;
esac

case "$cli_job_text" in
  *'secrets.'*) fail "CLI build job must not consume repository secrets" ;;
esac

case "$cli_job_text" in
  *'pnpm install'*|*'corepack enable'*|*'cache: pnpm'*)
    fail "CLI build job must not install or cache the desktop pnpm workspace"
    ;;
esac

grep -Fxq 'packages/cli/Cargo.toml' "$repo_root/scripts/release.sh" \
  || fail "release preflight must require the CLI package version to match the tag"

case "$cli_job_text" in
  *"permissions:"*"contents: read"*"node scripts/cargo-env.mjs cargo test --locked"*"-p cadencr-cli"*"-p cadencr-plugin-core"*"-p cadencr-registry-core"*"node scripts/cargo-env.mjs cargo build --locked --release -p cadencr-cli"*) ;;
  *) fail "workflow must build the CLI in a secret-free, read-only Linux job" ;;
esac

case "$workflow_text" in
  *"scripts/package-cli-release.sh"*"actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"*) ;;
  *) fail "workflow must smoke test, checksum, and transfer CLI release assets" ;;
esac

case "$workflow_text" in
  *"actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"*'shasum -a 256 --check "$cli_manifest"'*) ;;
  *) fail "desktop release job must download and verify the CLI checksum" ;;
esac

case "$workflow_text" in
  *'cadencr-${GITHUB_REF_NAME}-x86_64-unknown-linux-gnu'*'cadencr-${GITHUB_REF_NAME}-SHA256SUMS'*) ;;
  *) fail "workflow must upload the versioned Linux CLI and SHA256 manifest" ;;
esac

case "$workflow_text" in
  *"--publish never"*) ;;
  *) fail "desktop release workflow must build with electron-builder --publish never" ;;
esac

case "$workflow_text" in
  *"Create draft GitHub release"*) ;;
  *) fail "workflow must create exactly one draft GitHub release via gh" ;;
esac

case "$workflow_text" in
  *"Verify uploaded GitHub release assets"*) ;;
  *) fail "workflow must verify uploaded GitHub release assets before publishing" ;;
esac

case "$workflow_text" in
  *"latest-mac.yml"*"Cadencr-\${version}-arm64.dmg"*"Cadencr-\${version}.dmg"*) ;;
  *) fail "workflow must require updater metadata and both Homebrew DMGs" ;;
esac
