#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "update-homebrew-cask.test: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

test_log="$tmp_dir/commands.log"
tap_dir_file="$tmp_dir/tap-dir.txt"
rendered_cask_file="$tmp_dir/rendered-cadencr.rb"
stub_bin="$tmp_dir/bin"
mkdir -p "$stub_bin"

cat > "$stub_bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

download_dir=""
patterns=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pattern)
      shift
      patterns="${patterns}${patterns:+ }$1"
      ;;
    --dir)
      shift
      download_dir="$1"
      ;;
  esac
  shift
done

printf 'gh release download patterns=%s dir=%s\n' "$patterns" "$download_dir" >> "$TEST_LOG"
[ -n "$download_dir" ] || exit 1
printf 'arm64 dmg' > "$download_dir/Cadencr-9.8.7-arm64.dmg"
printf 'intel dmg' > "$download_dir/Cadencr-9.8.7.dmg"
SH
chmod +x "$stub_bin/gh"

cat > "$stub_bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

git_dir=""
if [ "${1:-}" = "clone" ]; then
  clone_url=""
  target=""
  for arg in "$@"; do
    case "$arg" in
      https://*)
        clone_url="$arg"
        ;;
      /*)
        target="$arg"
        ;;
    esac
  done
  printf 'git clone url=%s target=%s\n' "$clone_url" "$target" >> "$TEST_LOG"
  printf '%s\n' "$target" > "$TEST_TAP_DIR_FILE"
  mkdir -p "$target"
  exit 0
fi

if [ "${1:-}" = "-C" ]; then
  git_dir="$2"
  printf 'git -C command=%s\n' "$*" >> "$TEST_LOG"
  shift 2
fi

while [ "${1:-}" = "-c" ]; do
  shift 2
done

case "${1:-}" in
  add)
    cp "$git_dir/Casks/cadencr.rb" "$TEST_RENDERED_CASK_FILE"
    exit 0
    ;;
  commit|push)
    exit 0
    ;;
  diff)
    exit 1
    ;;
esac

echo "unexpected git invocation: $*" >&2
exit 1
SH
chmod +x "$stub_bin/git"

output_file="$tmp_dir/output.txt"
env -i \
  PATH="$stub_bin:/bin:/usr/bin" \
  LC_ALL=en_US.UTF-8 \
  HOMEBREW_TAP_TOKEN=dummy-token \
  TEST_LOG="$test_log" \
  TEST_TAP_DIR_FILE="$tap_dir_file" \
  TEST_RENDERED_CASK_FILE="$rendered_cask_file" \
  bash "$repo_root/scripts/update-homebrew-cask.sh" v9.8.7 \
  > "$output_file" 2>&1 || {
    cat "$output_file" >&2
    fail "script should render and push the cask without treating the ellipsis as part of TAP_REPO"
  }

grep -q "Updated merkr-software/homebrew-cadencr cask to 9.8.7." "$output_file" \
  || {
    cat "$output_file" >&2
    fail "expected successful cask update output"
  }

grep -q "patterns=Cadencr-9.8.7-arm64.dmg Cadencr-9.8.7.dmg" "$test_log" \
  || fail "expected exact DMG release asset patterns"

grep -q "github.com/merkr-software/homebrew-cadencr.git" "$test_log" \
  || fail "expected clone of the Homebrew tap repository"

grep -q "command=.* add Casks/cadencr.rb" "$test_log" \
  || fail "expected git add of rendered cask"

grep -q "command=.* commit -m cadencr 9.8.7" "$test_log" \
  || fail "expected git commit for cask version"

grep -q "command=.* push origin HEAD" "$test_log" \
  || fail "expected git push to tap repository"

tap_dir="$(cat "$tap_dir_file")"
cask_file="$rendered_cask_file"
[ -f "$cask_file" ] || fail "expected rendered cask at $cask_file"

expected_sha_arm="$(printf 'arm64 dmg' | shasum -a 256 | awk '{print $1}')"
expected_sha_intel="$(printf 'intel dmg' | shasum -a 256 | awk '{print $1}')"

grep -q 'version "9.8.7"' "$cask_file" \
  || fail "expected rendered cask version"

grep -q "$expected_sha_arm" "$cask_file" \
  || fail "expected rendered arm64 SHA-256"

grep -q "$expected_sha_intel" "$cask_file" \
  || fail "expected rendered intel SHA-256"
