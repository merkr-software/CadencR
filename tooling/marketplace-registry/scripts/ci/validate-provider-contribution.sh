#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: validate-provider-contribution.sh <trusted-pin.env> <base> <candidate> <validate|tooling>" >&2
  exit 2
fi
pin_file=$1
base=$2
candidate=$3
mode=$4
case "$mode" in validate|tooling) ;; *) echo "unknown validation mode: $mode" >&2; exit 2 ;; esac

version=$(sed -n 's/^CADENCR_RELEASE_VERSION=//p' "$pin_file")
sha256=$(sed -n 's/^CADENCR_RELEASE_SHA256=//p' "$pin_file")
lines=$(wc -l < "$pin_file" | tr -d ' ')
valid_lines=$(grep -Ec '^(#.*|[[:space:]]*|CADENCR_RELEASE_(VERSION|SHA256)=[^[:space:]]+)$' "$pin_file")
version_lines=$(grep -c '^CADENCR_RELEASE_VERSION=' "$pin_file" || true)
sha256_lines=$(grep -c '^CADENCR_RELEASE_SHA256=' "$pin_file" || true)
if [ "$valid_lines" -ne "$lines" ] ||
  [ "$version_lines" -ne 1 ] ||
  [ "$sha256_lines" -ne 1 ]; then
  echo "released CLI pin file has an unexpected field or malformed line" >&2
  exit 2
fi

if [ "$version" = PENDING ] && [ "$sha256" = PENDING ]; then
  echo "Released Cadencr CLI validation is pending a reviewed release pin; using legacy JavaScript gate."
  if [ "$mode" = validate ]; then
    exec node "$base/scripts/validate-contribution.mjs" --base "$base" --candidate "$candidate"
  fi
  cd "$candidate"
  npm ci --ignore-scripts --no-audit --no-fund
  npm test
  npm run validate
  set -- packages/*.json
  if [ -e "$1" ]; then
    generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    expires_at=$(node -e 'console.log(new Date(Date.now() + 7 * 86400000).toISOString())')
    npm run build:index -- --generated-at "$generated_at" --expires-at "$expires_at" --output "${RUNNER_TEMP:-/tmp}/managed-index.json"
  else
    echo "No publishable package JSON; skipping index assembly."
  fi
  exit 0
fi
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "released CLI version must be an exact semver without a leading v" >&2
  exit 2
fi
if ! printf '%s' "$sha256" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "released CLI SHA-256 must be 64 lowercase hexadecimal characters" >&2
  exit 2
fi

asset="cadencr-v${version}-x86_64-unknown-linux-gnu"
url="https://github.com/merkr-software/CadencR/releases/download/v${version}/${asset}"
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/cadencr-registry-validator.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
binary="$work/cadencr"

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
      url=$(sed -n 's/^[Ll]ocation:[[:space:]]*//p' "$work/headers" | tr -d '\r' | tail -n 1)
      case "$url" in
        https://github.com/*|https://objects.githubusercontent.com/*|https://release-assets.githubusercontent.com/*) ;;
        *) echo "released CLI download refused untrusted redirect" >&2; exit 1 ;;
      esac
      redirects=$((redirects + 1))
      ;;
    *) echo "released CLI download failed with HTTP $status" >&2; exit 1 ;;
  esac
done

actual=$(sha256sum "$binary" | cut -d ' ' -f 1)
[ "$actual" = "$sha256" ] || { echo "released CLI SHA-256 mismatch" >&2; exit 1; }
chmod 700 "$binary"
[ "$("$binary" --version)" = "cadencr $version" ] || { echo "released CLI version mismatch" >&2; exit 1; }
if [ "$mode" = validate ]; then
  "$binary" registry validate --base "$base" --candidate "$candidate"
else
  "$binary" registry validate --base "$base" --candidate "$candidate"
  set -- "$candidate"/packages/*.json
  if [ ! -e "$1" ]; then
    echo "No publishable package JSON; skipping index assembly."
    exit 0
  fi
  generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  expires_at=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)
  "$binary" registry build-index --packages "$candidate/packages" \
    --generated-at "$generated_at" --expires-at "$expires_at" \
    --output "${RUNNER_TEMP:-/tmp}/managed-index.json"
fi
