#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "package-cli-release.test: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/package-cli-release.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

binary_dir="$tmp/path with spaces"
mkdir -p "$binary_dir"
cat > "$binary_dir/cadencr" <<'SCRIPT'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] || exit 2
printf 'cadencr %s\n' "${FAKE_VERSION:-1.2.3}"
SCRIPT
chmod +x "$binary_dir/cadencr"

"$script" v1.2.3 x86_64-unknown-linux-gnu "$binary_dir/cadencr" "$tmp/dist" >/dev/null
asset="cadencr-v1.2.3-x86_64-unknown-linux-gnu"
manifest="cadencr-v1.2.3-SHA256SUMS"
[ -x "$tmp/dist/$asset" ] || fail "missing executable release asset"
[ -f "$tmp/dist/$manifest" ] || fail "missing checksum manifest"
(cd "$tmp/dist" && shasum -a 256 --check "$manifest" >/dev/null) \
  || fail "checksum manifest does not verify"
grep -Eq "^[0-9a-f]{64}  $asset$" "$tmp/dist/$manifest" \
  || fail "checksum manifest is not in sha256sum format"

if "$script" v1.2.4 x86_64-unknown-linux-gnu "$binary_dir/cadencr" "$tmp/wrong" >/dev/null 2>&1; then
  fail "script accepted a binary whose version differs from the tag"
fi

if "$script" v1.2.3 x86_64-unknown-linux-gnu "$binary_dir/cadencr" "$tmp/dist" >/dev/null 2>&1; then
  fail "script overwrote existing release outputs"
fi

mkdir -p "$tmp/stale-manifest"
touch "$tmp/stale-manifest/$manifest"
if "$script" v1.2.3 x86_64-unknown-linux-gnu "$binary_dir/cadencr" "$tmp/stale-manifest" >/dev/null 2>&1; then
  fail "script overwrote an existing checksum manifest"
fi

for invalid_tag in v01.2.3 v1.02.3 v1.2.03 v1.2.3.. v1.2.3-foo. v1.2.3-foo..bar v1.2.3-01; do
  if "$script" "$invalid_tag" x86_64-unknown-linux-gnu "$binary_dir/cadencr" "$tmp/invalid" >/dev/null 2>&1; then
    fail "script accepted invalid SemVer tag: $invalid_tag"
  fi
done

for valid_version in 1.2.3-foo- 1.2.3--foo; do
  valid_dir="$tmp/valid-$valid_version"
  FAKE_VERSION="$valid_version" \
    "$script" "v$valid_version" x86_64-unknown-linux-gnu "$binary_dir/cadencr" "$valid_dir" >/dev/null \
    || fail "script rejected valid SemVer tag: v$valid_version"
done

checksum_bin="$tmp/checksum-bin"
checksum_marker="$tmp/checksum-failed-once"
mkdir -p "$checksum_bin"
cat > "$checksum_bin/shasum" <<SCRIPT
#!/usr/bin/env bash
if [ "\${1:-}" = "-a" ] && [ "\${3:-}" = "--check" ] && [ ! -e "$checksum_marker" ]; then
  touch "$checksum_marker"
  exit 1
fi
exec /usr/bin/shasum "\$@"
SCRIPT
chmod +x "$checksum_bin/shasum"

retry_dir="$tmp/retry"
if PATH="$checksum_bin:$PATH" "$script" v1.2.3 x86_64-unknown-linux-gnu "$binary_dir/cadencr" "$retry_dir" >/dev/null 2>&1; then
  fail "script ignored injected checksum verification failure"
fi
[ ! -e "$retry_dir/$asset" ] || fail "failed checksum left a partial release asset"
[ ! -e "$retry_dir/$manifest" ] || fail "failed checksum left a partial manifest"
if find "$retry_dir" -mindepth 1 -print -quit | grep -q .; then
  fail "failed checksum left staging artifacts"
fi
PATH="$checksum_bin:$PATH" "$script" v1.2.3 x86_64-unknown-linux-gnu "$binary_dir/cadencr" "$retry_dir" >/dev/null
(cd "$retry_dir" && shasum -a 256 --check "$manifest" >/dev/null) \
  || fail "retry after checksum failure did not publish valid outputs"
