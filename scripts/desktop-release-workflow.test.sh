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

case "$workflow_text" in
  *"--publish always"*)
    fail "desktop release workflow must not let electron-builder publish directly"
    ;;
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

case "$workflow_text" in
  *"url: .*\\.AppImage\$"*"url: .*\\.deb\$"*"url: .*\\.rpm\$"*) ;;
  *) fail "workflow must verify latest-linux.yml contains every auto-updatable target" ;;
esac

case "$workflow_text" in
  *"/resources/package-type"*"= deb"*"= rpm"*) ;;
  *) fail "workflow must verify DEB and RPM updater package identities" ;;
esac
