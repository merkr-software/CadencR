#!/bin/sh
# Only this short setup runs with privilege. Candidate code runs after setpriv.
set -eu
[ "$#" -eq 10 ] || { echo 'expected uid, gid, checkout, handoff, prerequisites, work, manifest hash, source commit, prerequisite hash and Node root' >&2; exit 2; }
uid=$1
gid=$2
checkout=$3
handoff=$4
prerequisites=$5
work=$6
manifest_sha256=$7
source_commit=$8
prerequisites_sha256=$9
node_root=${10}
case "$uid:$gid" in *[!0-9:]*) echo 'numeric runtime uid/gid required' >&2; exit 2 ;; esac
[ "$uid" -ne 0 ]
mount --make-rprivate /
exec /usr/bin/python3 -B "$checkout/scripts/lsp-catalog-qa/linux_sandbox.py" \
  "$uid" "$gid" "$checkout" "$handoff" "$prerequisites" "$work" \
  "$manifest_sha256" "$source_commit" "$prerequisites_sha256" "$node_root"
