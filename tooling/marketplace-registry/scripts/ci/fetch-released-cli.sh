#!/bin/sh
# Trusted bootstrap: pin data is parsed, never sourced. Caller owns cleanup.
set -eu
pending=0
# Exit 3 is an API sentinel, never an external command's failure status.
trap 'status=$?; if [ "$status" -eq 3 ] && [ "$pending" -ne 1 ]; then exit 1; fi' EXIT
if [ "$#" -ne 2 ]; then
  echo "usage: fetch-released-cli.sh <pin.env> <new-owned-output-dir>" >&2
  exit 2
fi
pin_file=$1
output=$2
[ -f "$pin_file" ] && [ ! -L "$pin_file" ] || { echo "invalid released CLI pin file" >&2; exit 2; }
version=''
sha256=''
version_lines=0
sha256_lines=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) ;;
    CADENCR_RELEASE_VERSION=*) version_lines=$((version_lines + 1)); version=${line#*=} ;;
    CADENCR_RELEASE_SHA256=*) sha256_lines=$((sha256_lines + 1)); sha256=${line#*=} ;;
    *) echo "released CLI pin file has an unexpected field or malformed line" >&2; exit 2 ;;
  esac
done < "$pin_file"
[ "$version_lines" -eq 1 ] && [ "$sha256_lines" -eq 1 ] || {
  echo "released CLI pin file has an unexpected field or malformed line" >&2; exit 2;
}
if [ "$version" = PENDING ] && [ "$sha256" = PENDING ]; then
  echo "Released Cadencr CLI pin is PENDING." >&2
  pending=1
  exit 3
fi
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "released CLI version must be an exact semver without a leading v" >&2
  exit 2
fi
if ! printf '%s' "$sha256" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "released CLI SHA-256 must be 64 lowercase hexadecimal characters" >&2
  exit 2
fi

# mkdir is exclusive: existing files, directories and symlinks are refused.
[ ! -e "$output" ] && [ ! -L "$output" ] || { echo "released CLI output already exists" >&2; exit 1; }
umask 077
mkdir "$output"
work=$(cd "$output" && pwd -P)
binary="$work/cadencr"
asset="cadencr-v${version}-x86_64-unknown-linux-gnu"
url="https://github.com/merkr-software/CadencR/releases/download/v${version}/${asset}"
redirects=0
while :; do
  curl_status=0
  status=$(curl --silent --show-error --proto '=https' --max-redirs 0 \
    --connect-timeout 15 --max-time 120 --max-filesize 134217728 --dump-header "$work/headers" \
    --output "$binary" --write-out '%{http_code}' "$url") || curl_status=$?
  case "$status" in
    200) [ "$curl_status" -eq 0 ] || exit "$curl_status"; break ;;
    301|302|303|307|308)
      [ "$curl_status" -eq 0 ] || [ "$curl_status" -eq 47 ] || {
        echo "released CLI redirect response was truncated" >&2; exit "$curl_status";
      }
      [ "$redirects" -lt 3 ] || { echo "released CLI download exceeded redirect limit" >&2; exit 1; }
      location_count=$(awk 'tolower($0) ~ /^location:/ { count++ } END { print count + 0 }' "$work/headers")
      [ "$location_count" -eq 1 ] || { echo "released CLI download refused ambiguous redirect" >&2; exit 1; }
      url=$(awk 'tolower($0) ~ /^location:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print }' "$work/headers")
      case "$url" in
        https://github.com/*|https://objects.githubusercontent.com/*|https://release-assets.githubusercontent.com/*) ;;
        *) echo "released CLI download refused untrusted redirect" >&2; exit 1 ;;
      esac
      redirects=$((redirects + 1))
      ;;
    *) echo "released CLI download failed with HTTP $status" >&2; exit 1 ;;
  esac
done

size=$(wc -c < "$binary" | tr -d ' ')
[ "$size" -le 134217728 ] || { echo "released CLI exceeds size limit" >&2; exit 1; }
actual=$(sha256sum "$binary" | cut -d ' ' -f 1)
[ "$actual" = "$sha256" ] || { echo "released CLI SHA-256 mismatch" >&2; exit 1; }
chmod 700 "$binary"
# Bound the entire pipeline and retain the binary's status without an unbounded
# command substitution. An extra byte distinguishes oversized output.
if ! timeout --kill-after=2s 30s sh -c '
  (set +e; "$1" --version 2>/dev/null; result=$?; printf "%s\n" "$result" > "$3") |
    head -c 1025 > "$2"
' sh "$binary" "$work/version" "$work/version-status"; then
  echo "released CLI version check timed out or failed" >&2; exit 1
fi
[ -f "$work/version-status" ] && [ "$(cat "$work/version-status")" = 0 ] || {
  echo "released CLI version check failed" >&2; exit 1;
}
version_size=$(wc -c < "$work/version" | tr -d ' ')
[ "$version_size" -le 1024 ] || { echo "released CLI version output exceeds limit" >&2; exit 1; }
[ "$(cat "$work/version")" = "cadencr $version" ] || { echo "released CLI version mismatch" >&2; exit 1; }
printf '%s\n' "$binary"
