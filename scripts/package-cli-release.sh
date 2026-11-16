#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "package-cli-release: $*" >&2
  exit 1
}

if [ "$#" -ne 4 ]; then
  echo "Usage: scripts/package-cli-release.sh vX.Y.Z <target> <binary> <output-dir>" >&2
  exit 2
fi

tag="$1"
target="$2"
binary="$3"
output_dir="$4"

if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z.-]+))?(\+([0-9A-Za-z.-]+))?$ ]]; then
  fail "invalid release tag: $tag"
fi
prerelease="${BASH_REMATCH[5]:-}"
build_metadata="${BASH_REMATCH[7]:-}"
for identifier_list in "$prerelease" "$build_metadata"; do
  [ -z "$identifier_list" ] && continue
  [[ "$identifier_list" =~ ^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$ ]] \
    || fail "invalid release tag: $tag"
done
if [ -n "$prerelease" ]; then
  IFS='.' read -r -a identifiers <<< "$prerelease"
  for identifier in "${identifiers[@]}"; do
    if [[ "$identifier" =~ ^[0-9]+$ && "$identifier" != "0" && "$identifier" == 0* ]]; then
      fail "invalid release tag: $tag"
    fi
  done
fi
[[ "$target" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "invalid Rust target: $target"
[ -f "$binary" ] || fail "CLI binary does not exist: $binary"
[ -x "$binary" ] || fail "CLI binary is not executable: $binary"

expected_version="${tag#v}"
actual_version="$("$binary" --version)" \
  || fail "failed to run CLI version smoke test"
[ "$actual_version" = "cadencr $expected_version" ] \
  || fail "CLI version '$actual_version' does not match release tag $tag"

asset="cadencr-${tag}-${target}"
manifest="cadencr-${tag}-SHA256SUMS"
if [ -e "$output_dir/$asset" ] || [ -L "$output_dir/$asset" ]; then
  fail "refusing to overwrite existing release asset: $output_dir/$asset"
fi
if [ -e "$output_dir/$manifest" ] || [ -L "$output_dir/$manifest" ]; then
  fail "refusing to overwrite existing checksum manifest: $output_dir/$manifest"
fi
mkdir -p "$output_dir"
staging_dir="$(mktemp -d "$output_dir/.cadencr-cli-release.XXXXXX")"
staged_asset="$staging_dir/$asset"
staged_manifest="$staging_dir/$manifest"
published_asset="$output_dir/$asset"
published_manifest="$output_dir/$manifest"

cleanup() {
  if [ -e "$published_manifest" ] && [ "$published_manifest" -ef "$staged_manifest" ]; then
    rm -f "$published_manifest"
  fi
  if [ -e "$published_asset" ] && [ "$published_asset" -ef "$staged_asset" ]; then
    rm -f "$published_asset"
  fi
  rm -rf "$staging_dir"
}
trap cleanup EXIT

cp "$binary" "$staged_asset"
chmod 0755 "$staged_asset"

(
  cd "$staging_dir"
  shasum -a 256 "$asset" > "$manifest"
  shasum -a 256 --check "$manifest"
)

# Hard links provide atomic no-clobber publication. If the manifest publication
# loses a race, the trap removes only the asset linked to our staged inode.
ln "$staged_asset" "$published_asset" \
  || fail "refusing to overwrite existing release asset: $published_asset"
ln "$staged_manifest" "$published_manifest" \
  || fail "refusing to overwrite existing checksum manifest: $published_manifest"

trap - EXIT
rm -rf "$staging_dir"

printf '%s\n' "$published_asset" "$published_manifest"
