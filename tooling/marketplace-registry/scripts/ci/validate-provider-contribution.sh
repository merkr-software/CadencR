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

work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/cadencr-registry-validator.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
bootstrap_status=0
binary=$(sh "$script_dir/fetch-released-cli.sh" "$pin_file" "$work/released") || bootstrap_status=$?
if [ "$bootstrap_status" -eq 3 ]; then
  echo "Released Cadencr CLI validation is pending a reviewed release pin; using legacy JavaScript gate."
  if [ "$mode" = validate ]; then
    node "$base/scripts/validate-contribution.mjs" --base "$base" --candidate "$candidate"
    exit 0
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
[ "$bootstrap_status" -eq 0 ] || exit "$bootstrap_status"

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
