#!/bin/sh
# Preparation only. Candidate Git objects are data, never executable.
set -eu
mode=production
case "${1:-}" in
  --qualification) mode=qualification; shift ;;
  --author-approved) mode=author-approved; shift ;;
esac
case "${1:-}" in --*) echo 'preparation modes are mutually exclusive' >&2; exit 2 ;; esac
[ "$#" -eq 4 ] || { echo 'usage: official-plugin-release.sh [--qualification|--author-approved] <source-repo> <commit> <tag> <new-output>' >&2; exit 2; }
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
export ROOT
exec python3 "$ROOT/scripts/official-plugin-prepare.py" "$mode" "$@"
