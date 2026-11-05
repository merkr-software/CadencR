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
for directory in "$checkout" "$handoff" "$prerequisites" "$node_root"; do
  mount --bind "$directory" "$directory"
  mount -o remount,bind,ro "$directory"
done
exec setpriv --reuid "$uid" --regid "$gid" --clear-groups \
  --bounding-set=-all --no-new-privs env -i PATH=/usr/bin:/bin \
  HOME="$work" TMPDIR="$work" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  /usr/bin/python3 -B "$checkout/scripts/lsp-catalog-qa/runtime.py" \
  --handoff "$handoff" --manifest-sha256 "$manifest_sha256" --source-commit "$source_commit" \
  --target linux-x86_64 --prerequisites "$prerequisites" \
  --prerequisites-sha256 "$prerequisites_sha256" --work "$work/runtime" \
  --evidence "$work/evidence" --diagnostics "$work/diagnostics"
