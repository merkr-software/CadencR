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
#   package           release sidecar + AppImage/DEB/RPM for the container arch,
#                     copied to packages/desktop/dist-electron/linux-<arch>/
#   smoke             scripts/smoke-linux-packages.sh on those packages
#   e2e               headless launch of the packaged DEB and AppImage
#
# The working tree (tracked + untracked, minus ignored files) is synced into a
# Docker volume on every run; node_modules and Cargo artifacts stay in that
# volume, never mixing with the host's macOS builds.
#   CADENCR_LINUX_ARCH=x64|arm64  defaults to the Docker host arch (x64 on
#                                 Apple Silicon runs emulated and slowly)
#   CADENCR_LINUX_JOBS=N          Cargo parallelism (default 3; the service
#                                 test binary needs ~2 GB per job to link)
set -euo pipefail

fail() {
  echo "linux-container: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v docker > /dev/null || fail "docker is required"

host_arch="$(docker info --format '{{.Architecture}}')"
case "${CADENCR_LINUX_ARCH:-$host_arch}" in
  arm64 | aarch64) arch=arm64 platform=linux/arm64 ;;
  x64 | x86_64 | amd64) arch=x64 platform=linux/amd64 ;;
  *) fail "unsupported arch: ${CADENCR_LINUX_ARCH:-$host_arch}" ;;
esac

image="cadencr-linux-dev:$arch"
src_volume="cadencr-linux-src-$arch"
cache_volume="cadencr-linux-cache-$arch"
dist_dir="$repo_root/packages/desktop/dist-electron/linux-$arch"
version="$(node -p "require('$repo_root/packages/desktop/package.json').version")"

ensure_image() {
  if [ -n "${CADENCR_LINUX_REBUILD:-}" ] || ! docker image inspect "$image" > /dev/null 2>&1; then
    docker build --platform "$platform" -t "$image" "$repo_root/scripts/linux-container"
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

subcommand="${1:-}"
[ -n "$subcommand" ] || fail "usage: $0 shell|rust-test|clippy|vitest|package|smoke|e2e"
shift || true
mkdir -p "$dist_dir"
ensure_image
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
