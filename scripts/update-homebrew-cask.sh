#!/usr/bin/env bash
set -euo pipefail

# Regenerates the Homebrew cask in the tap repo for a published release.
# Downloads the notarized DMGs from the GitHub release, computes their SHA-256
# digests, renders homebrew/cadencr.rb.tmpl, and pushes the result to the tap.

usage() {
  echo "Usage: scripts/update-homebrew-cask.sh vX.Y.Z" >&2
}

fail() {
  echo "update-homebrew-cask: $*" >&2
  exit 1
}

UPDATE_HOMEBREW_CASK_WORKDIR=""
SOURCE_REPO="${CADENCR_RELEASE_REPO:-merkr-software/cadencr}"
TAP_REPO="${HOMEBREW_TAP_REPO:-merkr-software/homebrew-cadencr}"
TEMPLATE="homebrew/cadencr.rb.tmpl"

cleanup() {
  [ -z "$UPDATE_HOMEBREW_CASK_WORKDIR" ] || rm -rf "$UPDATE_HOMEBREW_CASK_WORKDIR"
}

main() {
  [ "$#" -eq 1 ] || { usage; exit 2; }
  local tag="$1"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "tag must match vX.Y.Z: $tag"
  local version="${tag#v}"

  : "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN is required to push to $TAP_REPO}"
  command -v gh >/dev/null || fail "gh CLI is required"
  [ -f "$TEMPLATE" ] || fail "missing cask template: $TEMPLATE"

  local workdir
  workdir="$(mktemp -d)"
  UPDATE_HOMEBREW_CASK_WORKDIR="$workdir"
  trap cleanup EXIT

  local arm_dmg="Cadencr-${version}-arm64.dmg"
  local intel_dmg="Cadencr-${version}.dmg"

  echo "Downloading release assets for $tag from ${SOURCE_REPO}…"
  gh release download "$tag" \
    --repo "$SOURCE_REPO" \
    --pattern "$arm_dmg" \
    --pattern "$intel_dmg" \
    --dir "$workdir" \
    || fail "failed to download DMG assets for $tag"

  local sha_arm sha_intel
  sha_arm="$(shasum -a 256 "$workdir/$arm_dmg" | awk '{print $1}')"
  sha_intel="$(shasum -a 256 "$workdir/$intel_dmg" | awk '{print $1}')"
  [ -n "$sha_arm" ] && [ -n "$sha_intel" ] || fail "failed to compute SHA-256 digests"

  local cask
  cask="$(sed \
    -e "s/__VERSION__/${version}/g" \
    -e "s/__SHA256_ARM__/${sha_arm}/g" \
    -e "s/__SHA256_INTEL__/${sha_intel}/g" \
    "$TEMPLATE")"

  echo "Cloning tap ${TAP_REPO}…"
  local tap_dir="$workdir/tap"
  git clone --depth 1 \
    "https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/${TAP_REPO}.git" \
    "$tap_dir" || fail "failed to clone tap $TAP_REPO"

  mkdir -p "$tap_dir/Casks"
  printf '%s\n' "$cask" > "$tap_dir/Casks/cadencr.rb"

  git -C "$tap_dir" add Casks/cadencr.rb
  if git -C "$tap_dir" diff --cached --quiet; then
    echo "Cask already up to date for $version; nothing to push."
    return 0
  fi

  git -C "$tap_dir" \
    -c user.name="cadencr-release-bot" \
    -c user.email="release-bot@users.noreply.github.com" \
    commit -m "cadencr ${version}" || fail "failed to commit cask update"
  git -C "$tap_dir" push origin HEAD || fail "failed to push to tap $TAP_REPO"

  echo "Updated $TAP_REPO cask to $version."
}

main "$@"
