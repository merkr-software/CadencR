#!/usr/bin/env bash
# Build, test and package Cadencr on Linux inside Docker — from a Mac (Docker
# Desktop runs arm64 Linux natively on Apple Silicon) or any Docker host.
#
#   scripts/linux-container.sh <command> [args]
#
# Commands:
#   shell             interactive shell in the synced Linux tree
#   rust-test [args]  workspace Rust tests on Linux (args go to `cargo test`)
#   clippy            workspace clippy on Linux (cfg(target_os = "linux") code)
#   vitest            desktop + landing unit tests on Linux
#   scripts           root script tests on Linux (`pnpm run test:scripts`)
#   run <command>     any command in the synced Linux tree, non-interactively
#   package           release sidecar + AppImage/DEB/RPM for the container arch,
#                     copied to packages/desktop/dist-electron/linux-<arch>/
#   smoke             scripts/smoke-linux-packages.sh on those packages
#   e2e               headless launch of the packaged DEB and AppImage
#   volume            print this checkout's source volume
#   clean             remove this checkout's source volume (tree, node_modules,
#                     Cargo target), under its current or its pre-label name;
#                     the next run starts from a cold build
#   prune [--dry-run] remove this repository's worktree volumes whose
#                     worktree git no longer knows (a removed worktree cannot
#                     `clean` its own); lists them first, `--dry-run` only lists.
#                     Volumes from before repository labels are only listed,
#                     with the command that removes them
#
# The working tree (tracked + untracked, minus ignored files) is synced into a
# Docker volume on every run; node_modules and Cargo artifacts stay in that
# volume, never mixing with the host's macOS builds. Like `pnpm rust` keeps a
# Cargo target per worktree, each checkout gets its own source volume: the main
# checkout `cadencr-linux-src-<arch>`, a linked worktree
# `cadencr-linux-src-<arch>-w<repository checksum>-<dir>-<path checksum>`, so
# two branches never overwrite each other's tree or build. Download caches
# (Cargo registry, pnpm store, Electron) stay in one shared volume. A volume
# this script creates is labelled with its checkout's path and its repository
# (the shared git directory), which is how `prune` finds this repository's
# orphans and never touches another's.
#   CADENCR_LINUX_SRC_VOLUME=name
#                                 use that source volume instead
#   CADENCR_LINUX_ARCH=x64|arm64  defaults to the Docker host arch (x64 on
#                                 Apple Silicon runs emulated and slowly)
#   CADENCR_LINUX_JOBS=N          Cargo parallelism (default 3; the service
#                                 test binary needs ~2 GB per job to link)
set -euo pipefail

fail() {
  echo "linux-container: $*" >&2
  exit 1
}

usage="usage: $0 shell|rust-test|clippy|vitest|scripts|run|package|smoke|e2e|volume|clean|prune [--dry-run]"
# Every argument is checked here, before any Docker call.
subcommand="${1:-}"
[ -n "$subcommand" ] || fail "$usage"
shift
prune_mode=remove
case "$subcommand" in
  shell | rust-test | clippy | vitest | scripts | run | package | smoke | e2e) ;;
  volume | clean) [ "$#" -eq 0 ] || fail "usage: $0 $subcommand" ;;
  prune)
    for arg in "$@"; do
      case "$arg" in
        --dry-run) prune_mode=dry-run ;;
        *) fail "usage: $0 prune [--dry-run]" ;;
      esac
    done
    ;;
  *) fail "unknown command: $subcommand ($usage)" ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# The repository every worktree of it shares: its common git directory.
repo_id="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)" \
  || fail "$repo_root is not a git checkout"
repo_id="$(cd "$repo_id" && pwd -P)"
repo_sum="$(printf '%s' "$repo_id" | cksum | cut -d' ' -f1)"

# A linked worktree has a `.git` file; the main checkout a `.git` directory and
# the volume name it always had, so its warm build survives.
source_volume() {
  if [ -n "${CADENCR_LINUX_SRC_VOLUME:-}" ]; then
    printf '%s\n' "$CADENCR_LINUX_SRC_VOLUME"
  elif [ -f "$repo_root/.git" ]; then
    local dir sum
    dir="$(basename "$repo_root" | LC_ALL=C tr -c 'A-Za-z0-9_.\n-' '-' | cut -c1-40)"
    sum="$(printf '%s' "$repo_root" | cksum | cut -d' ' -f1)"
    printf 'cadencr-linux-src-%s-w%s-%s-%s\n' "$1" "$repo_sum" "$dir" "$sum"
  else
    printf 'cadencr-linux-src-%s\n' "$1"
  fi
}

# Before repository-scoped names, a worktree's volume was named from its path
# alone (as the shell spelled it, symlinks included): `clean` removes it too.
legacy_source_volumes() {
  [ -z "${CADENCR_LINUX_SRC_VOLUME:-}" ] && [ -f "$repo_root/.git" ] || return 0
  local dir root
  dir="$(basename "$repo_root" | LC_ALL=C tr -c 'A-Za-z0-9_.\n-' '-' | cut -c1-40)"
  for root in "$repo_root" "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; do
    printf 'cadencr-linux-src-%s-%s-%s\n' "$1" "$dir" "$(printf '%s' "$root" | cksum | cut -d' ' -f1)"
  done | sort -u
}

host_arch="${CADENCR_LINUX_ARCH:-}"
if [ -z "$host_arch" ]; then
  command -v docker > /dev/null || fail "docker is required"
  host_arch="$(docker info --format '{{.Architecture}}')"
fi
case "$host_arch" in
  arm64 | aarch64) arch=arm64 platform=linux/arm64 ;;
  x64 | x86_64 | amd64) arch=x64 platform=linux/amd64 ;;
  *) fail "unsupported arch: $host_arch" ;;
esac

node_version="$(sed 's/^v//; s/[[:space:]]*$//' "$repo_root/.nvmrc")"
image="cadencr-linux-dev:$arch-node$node_version"
src_volume="$(source_volume "$arch")"
cache_volume="cadencr-linux-cache-$arch"
dist_dir="$repo_root/packages/desktop/dist-electron/linux-$arch"
version="$(node -p "require('$repo_root/packages/desktop/package.json').version")"

ensure_image() {
  if [ -n "${CADENCR_LINUX_REBUILD:-}" ] || ! docker image inspect "$image" > /dev/null 2>&1; then
    docker build --platform "$platform" --build-arg "NODE_VERSION=$node_version" \
      -t "$image" "$repo_root/scripts/linux-container"
  fi
}

# Each sync records the files it wrote and deletes those the previous sync
# wrote that the host no longer has, so a deleted or renamed source file cannot
# linger. Build outputs (node_modules, target, out) were never synced, so they
# are never in a manifest and survive. `git ls-files -c` still lists tracked
# files deleted but not staged, which tar would fail on: skip them. Synced files
# and every directory above them go to `dev` (uid 1000) on each run, whatever
# the host uid, so pnpm can always write next to them.
sync_tree() {
  docker volume inspect "$src_volume" > /dev/null 2>&1 \
    || docker volume create --label "cadencr.checkout=$repo_root" \
      --label "cadencr.repo=$repo_id" "$src_volume" > /dev/null
  (
    cd "$repo_root"
    git ls-files -co --exclude-standard -z \
      | while IFS= read -r -d '' file; do
        if [ -e "$file" ] || [ -L "$file" ]; then printf '%s\0' "$file"; fi
      done \
      | COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -cf -
  ) | docker run --rm -i --platform "$platform" -v "$src_volume:/src" "$image" bash -euo pipefail -c '
      cd /src
      tar --no-same-owner -xvf - > /tmp/synced
      awk -F/ "{ p = \$1; print p; for (i = 2; i < NF; i++) { p = p \"/\" \$i; print p } }" /tmp/synced \
        | sort -u | cat - /tmp/synced | tr "\n" "\0" | xargs -0 -r chown -h 1000:1000
      chown 1000:1000 /src
      if [ -f .linux-container-manifest ]; then
        sort -u /tmp/synced > /tmp/new
        sort -u .linux-container-manifest | comm -23 - /tmp/new | while IFS= read -r stale; do
          rm -f -- "$stale"
        done
      fi
      mv /tmp/synced .linux-container-manifest'
}

# The device lives in Docker's VM on a Mac, not on the host, so ask Docker.
host_has_fuse() {
  docker run --rm --platform "$platform" --device /dev/fuse "$image" true > /dev/null 2>&1
}

# Runs $2 in the container as `dev` (uid 1000), or as root when $1 is "root".
# `--init` reaps orphans, which process-tree tests wait for.
container_run() {
  local user="$1" script="$2"
  local interactive=()
  [ -t 0 ] && [ -t 1 ] && interactive=(-it)
  # `${a[@]+…}` keeps an empty array safe under `set -u` on macOS bash 3.2.
  local privileges=()
  # e2e mounts the AppImage through FUSE, like a desktop session does. Docker
  # refuses to start a container asking for a device the host lacks, so only
  # ask when it has one; e2e_script then falls back to extract-and-run.
  if [ "$user" = root ]; then
    if host_has_fuse; then
      privileges=(--device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined)
    else
      echo "linux-container: no /dev/fuse on the Docker host; the AppImage runs extracted" >&2
    fi
  fi
  docker run --rm --init ${interactive[@]+"${interactive[@]}"} ${privileges[@]+"${privileges[@]}"} --platform "$platform" \
    -v "$src_volume:/src" \
    -v "$cache_volume:/cache" \
    -v "$dist_dir:/out" \
    -e CARGO_BUILD_JOBS="${CADENCR_LINUX_JOBS:-3}" \
    -e CARGO_HOME=/cache/cargo \
    -e npm_config_store_dir=/cache/pnpm-store \
    -e ELECTRON_CACHE=/cache/electron \
    -e COREPACK_HOME=/cache/corepack \
    -e ELECTRON_BUILDER_CACHE=/cache/electron-builder \
    -e CI=1 \
    -e CADENCR_CONTAINER_USER="$user" \
    -e CADENCR_CONTAINER_SCRIPT="$script" \
    -w /src "$image" bash -euo pipefail -c '
      if [ "$CADENCR_CONTAINER_USER" = root ]; then exec bash -euo pipefail -c "$CADENCR_CONTAINER_SCRIPT"; fi
      # Volumes from earlier root runs or a fresh cache volume: hand each to dev
      # once. Checked apart: sync_tree already gives /src to dev on every run.
      [ "$(stat -c %u /src)" = 1000 ] || chown -R dev:dev /src
      [ "$(stat -c %u /cache)" = 1000 ] || chown -R dev:dev /cache
      exec setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/dev \
        bash -euo pipefail -c "$CADENCR_CONTAINER_SCRIPT"'
}

run_in() { container_run dev "$1"; }
run_as_root() { container_run root "$1"; }

# First run in a fresh cache volume: seed Cargo's home with the image toolchain.
bootstrap='
  if [ ! -x /cache/cargo/bin/cargo ]; then mkdir -p /cache/cargo && cp -a /usr/local/cargo/. /cache/cargo/; fi
  export PATH=/cache/cargo/bin:$PATH
  pnpm install --frozen-lockfile > /tmp/pnpm-install.log 2>&1 || { tail -40 /tmp/pnpm-install.log; exit 1; }
'

package_script="$bootstrap
  node packages/desktop/scripts/ensure-electron.mjs
  (cd packages/desktop && NODE_OPTIONS=--max-old-space-size=4096 node ./scripts/electron-vite.mjs build)
  pnpm --filter @cadencr/service build:sidecars
  pnpm --filter @cadencr/service smoke:packaged-sidecar /src/packages/desktop/resources/bin/$arch/cadencr-service
  rm -rf packages/desktop/dist-electron/*.AppImage packages/desktop/dist-electron/*.deb packages/desktop/dist-electron/*.rpm
  (cd packages/desktop && pnpm exec electron-builder --config electron-builder.yml --linux --$arch --publish never)
  rm -rf /out/* && cp packages/desktop/dist-electron/*.AppImage \
    packages/desktop/dist-electron/*.deb packages/desktop/dist-electron/*.rpm packages/desktop/dist-electron/latest-linux*.yml /out/
  ls -la /out"

e2e_script='
  set -x
  deb=$(ls /out/*.deb | head -n1)
  apt-get update -qq && apt-get install -y -qq "$deb" > /dev/null
  node /src/scripts/linux-container/e2e-launch.mjs /usr/bin/cadencr
  apt-get remove -y -qq cadencr > /dev/null
  appimage=$(ls /out/*.AppImage | head -n1)
  # electron-builder'"'"'s arm64 AppImage runtime links libz.so (not libz.so.1);
  # provide it so the launch itself can be exercised (tracked in LINUX_PORTING_PLAN.md).
  if [ "$(dpkg --print-architecture)" = arm64 ]; then apt-get install -y -qq zlib1g-dev > /dev/null; fi
  cp "$appimage" /tmp/Cadencr.AppImage && chmod +x /tmp/Cadencr.AppImage
  # Launch through a FUSE mount like users do when the host allows it.
  if [ -e /dev/fuse ] && apt-get install -y -qq fuse libfuse2 > /dev/null; then
    node /src/scripts/linux-container/e2e-launch.mjs /tmp/Cadencr.AppImage --appimage-fuse
  else
    node /src/scripts/linux-container/e2e-launch.mjs /tmp/Cadencr.AppImage --appimage
  fi
'

# One volume label, empty when unset (`docker volume inspect` prints nothing,
# or `<no value>` when the volume has other labels).
volume_label() {
  local value
  value="$(docker volume inspect -f "{{ index .Labels \"$2\" }}" "$1")" || return 1
  [ "$value" = "<no value>" ] || printf '%s' "$value"
}

# Every volume name, one per line; a failing Docker stops the script rather
# than reading as "no volume".
volume_names() {
  docker volume ls -q "$@" || fail "docker volume ls failed; nothing removed"
}

# macOS reaches /tmp and /var through /private: compare paths without it.
comparable_path() { printf '%s\n' "${1#/private}"; }

# This repository's worktree volumes whose worktree is gone, printed before
# any removal. A volume qualifies only if all hold: this repository's label,
# this repository's worktree name prefix, not a main checkout's volume, a
# checkout path that is not the main checkout, that git no longer lists as a
# worktree (a worktree git still knows, on an unmounted disk for instance, is
# kept) and that does not exist. Volumes from before repository labels are
# only listed, for removal by hand. `dry-run` only reads; any Docker failure
# stops before anything is removed.
prune_volumes() {
  local mode="$1" known main volumes volume repo checkout count=0 failed=0 orphans=()
  known="$(git -C "$repo_root" worktree list --porcelain | sed -n 's/^worktree //p')" \
    || fail "could not list this repository's git worktrees; nothing removed"
  main="$(printf '%s\n' "$known" | head -n 1)"
  known="$(printf '%s\n' "$known" | while IFS= read -r path; do comparable_path "$path"; done)"
  volumes="$(volume_names --filter name=cadencr-linux-src-)" || exit 1
  while IFS= read -r volume; do
    case "$volume" in
      cadencr-linux-src-arm64 | cadencr-linux-src-x64 | "") continue ;;
      cadencr-linux-src-*) ;;
      *) continue ;;
    esac
    repo="$(volume_label "$volume" cadencr.repo)" \
      || fail "docker volume inspect $volume failed; nothing removed"
    if [ -z "$repo" ]; then
      echo "linux-container: legacy $volume has no repository label, so it is not" \
        "removed; if no checkout uses it, remove it by hand: docker volume rm $volume"
      continue
    fi
    [ "$repo" = "$repo_id" ] || continue
    case "$volume" in cadencr-linux-src-*-w"$repo_sum"-*) ;; *) continue ;; esac
    checkout="$(volume_label "$volume" cadencr.checkout)" \
      || fail "docker volume inspect $volume failed; nothing removed"
    case "$checkout" in /?*) ;; *) continue ;; esac
    [ "$(comparable_path "$checkout")" = "$(comparable_path "$main")" ] && continue
    printf '%s\n' "$known" | grep -Fxq -- "$(comparable_path "$checkout")" && continue
    [ -e "$checkout" ] && continue
    orphans+=("$volume")
    count=$((count + 1))
    echo "linux-container: orphan $volume (worktree $checkout is gone)"
  done <<< "$volumes"
  if [ "$count" -eq 0 ]; then
    echo "linux-container: no orphan volume"
    return
  fi
  if [ "$mode" = dry-run ]; then
    echo "linux-container: dry run, nothing removed"
    return
  fi
  for volume in "${orphans[@]}"; do
    if docker volume rm "$volume" > /dev/null; then
      echo "linux-container: removed $volume"
    else
      echo "linux-container: could not remove $volume (still in use?)" >&2
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] || fail "some orphan volumes were not removed"
}

if [ "$subcommand" = volume ]; then
  printf '%s\n' "$src_volume"
  exit 0
fi
command -v docker > /dev/null || fail "docker is required"
if [ "$subcommand" = clean ]; then
  volumes="$(volume_names)" || exit 1
  removed=0
  for volume in "$src_volume" $(legacy_source_volumes "$arch"); do
    printf '%s\n' "$volumes" | grep -Fxq -- "$volume" || continue
    docker volume rm "$volume" > /dev/null || fail "could not remove $volume (still in use?)"
    echo "linux-container: removed $volume"
    removed=1
  done
  [ "$removed" -eq 1 ] || echo "linux-container: no volume $src_volume"
  exit 0
fi
if [ "$subcommand" = prune ]; then
  prune_volumes "$prune_mode"
  exit 0
fi
echo "linux-container: source volume $src_volume" >&2
mkdir -p "$dist_dir"
if [ "$subcommand" != smoke ]; then
  ensure_image
fi
case "$subcommand" in
  shell)
    sync_tree
    run_in "$bootstrap exec bash"
    ;;
  rust-test)
    sync_tree
    run_in "$bootstrap pnpm rust -- test --workspace $*"
    ;;
  clippy)
    sync_tree
    run_in "$bootstrap pnpm rust -- clippy --workspace --all-targets -- -D warnings"
    ;;
  vitest)
    sync_tree
    run_in "$bootstrap pnpm --filter @cadencr/desktop exec vitest run && pnpm --filter @cadencr/landing test"
    ;;
  scripts)
    sync_tree
    run_in "$bootstrap pnpm run test:scripts"
    ;;
  run)
    [ "$#" -gt 0 ] || fail "usage: $0 run <command>"
    sync_tree
    run_in "$bootstrap $*"
    ;;
  package)
    sync_tree
    run_in "$package_script"
    ;;
  smoke)
    "$repo_root/scripts/smoke-linux-packages.sh" "$dist_dir" "$version" "$arch"
    ;;
  e2e)
    sync_tree
    run_as_root "$e2e_script"
    ;;
  *) fail "unknown command: $subcommand" ;;
esac
