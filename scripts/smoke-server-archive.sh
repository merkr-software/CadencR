#!/usr/bin/env bash
# Smoke-tests a CadencR server archive on the machine it targets: unpack it,
# run `cadencr serve` against a throwaway home (never a real database; it
# binds the desktop app's port 5004, so no CadencR may be running), check
# remote access and pairing, add a project over the headless API, then stop it
# and check it cleaned up.
#
# Usage: scripts/smoke-server-archive.sh <cadencr-server-*.tar.gz>
set -euo pipefail

fail() {
  echo "smoke-server-archive: $*" >&2
  [ -f "${tmp:-}/serve.err" ] && tail -40 "$tmp/serve.err" >&2
  exit 1
}

[ "$#" -eq 1 ] || { echo "Usage: $0 <archive>" >&2; exit 2; }
archive="$1"
[ -f "$archive" ] || fail "archive not found: $archive"

tmp="$(mktemp -d)"
serve_pid=""
cleanup() {
  if [ -n "$serve_pid" ] && kill -0 "$serve_pid" 2>/dev/null; then
    kill -TERM "$serve_pid" 2>/dev/null || true
    wait "$serve_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$tmp"
cli="$tmp/cadencr-server/bin/cadencr"
[ -x "$cli" ] || fail "no executable cadencr-server/bin/cadencr"
"$cli" --version > /dev/null || fail "cadencr --version failed"

# Throwaway data roots for both platforms' path rules.
export HOME="$tmp/home"
export XDG_DATA_HOME="$tmp/home/data" XDG_CONFIG_HOME="$tmp/home/config" XDG_CACHE_HOME="$tmp/home/cache"
mkdir -p "$HOME" "$tmp/project"

"$cli" --json serve --remote-port 5916 > "$tmp/serve.out" 2> "$tmp/serve.err" &
serve_pid=$!
for _ in $(seq 1 120); do
  grep -q '"code":"SERVE_READY"' "$tmp/serve.out" && break
  kill -0 "$serve_pid" 2>/dev/null || fail "cadencr serve exited before it was ready"
  sleep 1
done
grep -q '"code":"SERVE_READY"' "$tmp/serve.out" || fail "cadencr serve was not ready within 120 s"
grep -q '"remote_port":5916' "$tmp/serve.out" || fail "remote access did not start"

"$cli" --json pair | grep -q '"code":"PAIRING_CODE"' || fail "cadencr pair failed"
"$cli" add "$tmp/project" | grep -q 'Added the project "project"' || fail "cadencr add failed"
"$cli" add "$tmp/project" | grep -q 'is already the project' || fail "cadencr add duplicated a project"

kill -TERM "$serve_pid"
wait "$serve_pid" || fail "cadencr serve did not stop cleanly"
serve_pid=""
if "$cli" pair > /dev/null 2>&1; then
  fail "the connection file outlived cadencr serve"
fi
echo "Server archive smoke test passed: $archive"
