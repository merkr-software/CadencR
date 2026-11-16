#!/usr/bin/env bash
# Packages the CadencR server archive: the `cadencr` CLI, the service and the
# built interface, for machines that run CadencR headless (`cadencr serve`)
# without the desktop app. `cadencr update` on such a machine downloads this
# archive and its `.sha256` from the release; the layout below is the one the
# CLI recognizes (packages/cli/src/app/install.rs):
#
#   cadencr-server/bin/cadencr
#   cadencr-server/lib/cadencr-service
#   cadencr-server/lib/renderer/        (without source maps)
#   cadencr-server/lib/server.json      {"version": ..., "platform": ...}
set -euo pipefail

fail() {
  echo "package-server-archive: $*" >&2
  exit 1
}

if [ "$#" -ne 6 ]; then
  echo "Usage: scripts/package-server-archive.sh <version> <platform> <cli> <service> <renderer-dir> <output-dir>" >&2
  exit 2
fi

version="$1"
platform="$2"
cli="$3"
service="$4"
renderer="$5"
output_dir="$6"

[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "invalid version: $version"
case "$platform" in
  linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64) ;;
  *) fail "invalid platform: $platform" ;;
esac
[ -f "$cli" ] && [ -x "$cli" ] || fail "CLI binary is missing or not executable: $cli"
[ -f "$service" ] && [ -x "$service" ] || fail "service binary is missing or not executable: $service"
[ -f "$renderer/index.html" ] || fail "renderer has no index.html: $renderer"

archive="cadencr-server-${version}-${platform}.tar.gz"
checksum="${archive}.sha256"
for output in "$archive" "$checksum"; do
  if [ -e "$output_dir/$output" ] || [ -L "$output_dir/$output" ]; then
    fail "refusing to overwrite existing output: $output_dir/$output"
  fi
done

mkdir -p "$output_dir"
staging="$(mktemp -d "$output_dir/.cadencr-server-archive.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

root="$staging/cadencr-server"
mkdir -p "$root/bin" "$root/lib"
cp "$cli" "$root/bin/cadencr"
cp "$service" "$root/lib/cadencr-service"
chmod 0755 "$root/bin/cadencr" "$root/lib/cadencr-service"
cp -R "$renderer" "$root/lib/renderer"
find "$root/lib/renderer" -name '*.map' -type f -delete
printf '{"version":"%s","platform":"%s"}\n' "$version" "$platform" > "$root/lib/server.json"

# Reproducible with GNU tar (the Linux release runner); plain elsewhere.
tar_flags=()
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar_flags=(--sort=name --owner=0 --group=0 --numeric-owner --mtime=@0)
fi
# COPYFILE_DISABLE keeps macOS bsdtar from adding AppleDouble `._*` entries.
(cd "$staging" && COPYFILE_DISABLE=1 tar "${tar_flags[@]+"${tar_flags[@]}"}" -cf - cadencr-server) \
  | gzip -n -9 > "$staging/$archive"

if command -v sha256sum > /dev/null; then
  (cd "$staging" && sha256sum "$archive") > "$staging/$checksum"
else
  (cd "$staging" && shasum -a 256 "$archive") > "$staging/$checksum"
fi
grep -Eq "^[0-9a-f]{64}  ${archive}$" "$staging/$checksum" \
  || fail "unexpected checksum format"

mv "$staging/$archive" "$output_dir/$archive"
mv "$staging/$checksum" "$output_dir/$checksum"
echo "$output_dir/$archive"
