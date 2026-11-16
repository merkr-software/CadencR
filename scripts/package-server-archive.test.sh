#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "package-server-archive.test: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/package-server-archive.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

inputs="$tmp/inputs with spaces"
mkdir -p "$inputs/renderer/assets"
printf '#!/bin/sh\n' > "$inputs/cadencr"
printf '#!/bin/sh\n' > "$inputs/cadencr-service"
chmod +x "$inputs/cadencr" "$inputs/cadencr-service"
printf '<!doctype html>' > "$inputs/renderer/index.html"
printf 'js' > "$inputs/renderer/assets/app.js"
printf 'map' > "$inputs/renderer/assets/app.js.map"

run() {
  "$script" "$1" linux-x64 "$inputs/cadencr" "$inputs/cadencr-service" "$inputs/renderer" "$2"
}

run 1.2.3 "$tmp/dist" > /dev/null
archive="cadencr-server-1.2.3-linux-x64.tar.gz"
[ -f "$tmp/dist/$archive" ] || fail "missing archive"
(cd "$tmp/dist" && shasum -a 256 --check "$archive.sha256" > /dev/null) \
  || fail "checksum does not verify"

if tar -tzf "$tmp/dist/$archive" | grep -Ev '^cadencr-server(/|$)' | grep -q . \
  || tar -tzf "$tmp/dist/$archive" | grep -q '/\._'; then
  fail "the archive holds entries outside cadencr-server/ or AppleDouble files"
fi

mkdir "$tmp/unpacked"
tar -xzf "$tmp/dist/$archive" -C "$tmp/unpacked"
root="$tmp/unpacked/cadencr-server"
[ -x "$root/bin/cadencr" ] || fail "CLI is not executable in the archive"
[ -x "$root/lib/cadencr-service" ] || fail "service is not executable in the archive"
[ -f "$root/lib/renderer/index.html" ] || fail "renderer index missing"
[ -f "$root/lib/renderer/assets/app.js" ] || fail "renderer asset missing"
[ ! -e "$root/lib/renderer/assets/app.js.map" ] || fail "source map was packaged"
[ "$(cat "$root/lib/server.json")" = '{"version":"1.2.3","platform":"linux-x64"}' ] \
  || fail "unexpected server.json"
[ -f "$inputs/renderer/assets/app.js.map" ] || fail "source map removed from the input"

if run 1.2.3 "$tmp/dist" > /dev/null 2>&1; then
  fail "script overwrote an existing archive"
fi
for invalid in v1.2.3 1.2 01.2.3 1.2.3-beta; do
  if run "$invalid" "$tmp/invalid" > /dev/null 2>&1; then
    fail "script accepted invalid version: $invalid"
  fi
done
if "$script" 1.2.3 windows-x64 "$inputs/cadencr" "$inputs/cadencr-service" "$inputs/renderer" "$tmp/x" \
  > /dev/null 2>&1; then
  fail "script accepted an unknown platform"
fi
rm "$inputs/renderer/index.html"
if run 1.2.4 "$tmp/no-index" > /dev/null 2>&1; then
  fail "script accepted a renderer without index.html"
fi
if find "$tmp/no-index" -mindepth 1 -print -quit 2> /dev/null | grep -q .; then
  fail "a failed run left files behind"
fi

echo "package-server-archive tests passed"
