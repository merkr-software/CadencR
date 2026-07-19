#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "release-notes.test: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/release-notes.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/CHANGELOG.md" <<'EOF'
# Changelog

## v1.2.3 - 2026-07-17

Previous release: v1.2.2 - 2026-07-16

### 🐛 Fixed

- Kept the complete changelog intact.

## v1.2.2 - 2026-07-16

- Previous release notes.
EOF
cp "$tmp_dir/CHANGELOG.md" "$tmp_dir/expected-changelog.md"

if (cd "$tmp_dir" && "$script" v1.2.3 ./CHANGELOG.md >stdout.txt 2>stderr.txt); then
  fail "script must reject CHANGELOG.md as its output file"
fi

grep -q "refusing to overwrite source CHANGELOG.md" "$tmp_dir/stderr.txt" \
  || fail "expected an explicit source-overwrite error"
cmp -s "$tmp_dir/expected-changelog.md" "$tmp_dir/CHANGELOG.md" \
  || fail "CHANGELOG.md changed after a rejected output path"

(cd "$tmp_dir" && "$script" v1.2.3 release-notes.md)
grep -q '^## v1\.2\.3 - 2026-07-17$' "$tmp_dir/release-notes.md" \
  || fail "expected the requested release heading"
if grep -q '^## v1\.2\.2' "$tmp_dir/release-notes.md"; then
  fail "release output must not include the previous release"
fi
grep -q '^## Install$' "$tmp_dir/release-notes.md" \
  || fail "expected platform installation instructions"
grep -q 'brew install --cask merkr-software/cadencr/cadencr' "$tmp_dir/release-notes.md" \
  || fail "expected Homebrew installation instructions"
grep -q 'sudo apt install ./Cadencr-1.2.3-amd64.deb' "$tmp_dir/release-notes.md" \
  || fail "expected versioned Debian installation instructions"
grep -q 'sudo dnf install ./Cadencr-1.2.3-x86_64.rpm' "$tmp_dir/release-notes.md" \
  || fail "expected RPM installation instructions"
grep -q 'sudo zypper install ./Cadencr-1.2.3-x86_64.rpm' "$tmp_dir/release-notes.md" \
  || fail "expected openSUSE installation instructions"

echo "release-notes tests passed"
