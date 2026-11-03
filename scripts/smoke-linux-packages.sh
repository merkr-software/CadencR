#!/usr/bin/env bash
# Smoke-tests built Linux desktop packages: the AppImage payload, then a real
# install of the DEB and RPM in clean distro containers (Debian, Ubuntu LTS,
# Fedora, Rocky/RHEL 9 with its older glibc, openSUSE), checking the sidecar
# runs and electron-updater's package identity.
#
#   scripts/smoke-linux-packages.sh <dist-dir> <version> [x64|arm64]
#
# Needs docker. Runs in CI on x64 and locally (e.g. Docker Desktop on Apple
# Silicon) on arm64.
set -euo pipefail

fail() {
  echo "smoke-linux-packages: $*" >&2
  exit 1
}

[ "$#" -ge 2 ] || fail "usage: $0 <dist-dir> <version> [x64|arm64]"
dist_dir="$(cd "$1" && pwd)"
version="$2"
arch="${3:-x64}"

case "$arch" in
  x64) appimage_arch="x86_64" deb_arch="amd64" rpm_arch="x86_64" platform="linux/amd64" feed="latest-linux.yml" ;;
  arm64) appimage_arch="arm64" deb_arch="arm64" rpm_arch="aarch64" platform="linux/arm64" feed="latest-linux-arm64.yml" ;;
  *) fail "unsupported arch: $arch" ;;
esac

appimage="Cadencr-${version}-${appimage_arch}.AppImage"
deb="Cadencr-${version}-${deb_arch}.deb"
rpm="Cadencr-${version}-${rpm_arch}.rpm"
for asset in "$appimage" "$deb" "$rpm" "$feed"; do
  [ -f "$dist_dir/$asset" ] || fail "missing $dist_dir/$asset"
done

# electron-updater picks the file matching the install type from this list.
for asset in "$appimage" "$deb" "$rpm"; do
  grep -Fq "url: $asset" "$dist_dir/$feed" || fail "$feed does not list $asset"
done
# The AppImage embeds its block map (differential updates read it from the file).
[ ! -e "$dist_dir/$appimage.blockmap" ] || fail "unexpected detached $appimage.blockmap"

failures=()
# Runs one containerised check; records a failure instead of stopping so a run
# reports every broken target at once.
check() {
  local label="$1"
  shift
  echo "==> $label"
  if "$@"; then
    echo "PASS $label"
  else
    echo "FAIL $label"
    failures+=("$label")
  fi
}

# Keep extraction inside the container: a root-owned payload on a host bind
# mount cannot be cleaned up by the unprivileged runner after a successful test.
# The original AppImage stays read-only, like the DEB and RPM below.
check "AppImage payload ($appimage)" docker run --rm --platform "$platform" -v "$dist_dir:/pkg:ro" -w /tmp debian:12 bash -eu -c "
  cp '/pkg/$appimage' .
  chmod +x '$appimage'
  ./'$appimage' --appimage-extract > /dev/null
  test -x squashfs-root/resources/cadencr-service
  squashfs-root/resources/cadencr-service --help > /dev/null
  # AppImages install no package, so electron-updater must not see an identity.
  test ! -e squashfs-root/resources/package-type
"

# Every library the Electron binary links must resolve on a stock install:
# a missing one (ALSA, GBM…) installs fine but the app never opens.
libs_check='
  app="$(dirname "$(dirname "$sidecar")")/cadencr"
  test -x "$app"
  missing=$(ldd "$app" | grep "not found" || true)
  if [ -n "$missing" ]; then echo "$missing" >&2; exit 1; fi
'
deb_check='
  sidecar=$(dpkg -L cadencr | grep -E "/resources/cadencr-service$" | head -n1)
  package_type=$(dpkg -L cadencr | grep -E "/resources/package-type$" | head -n1)
  test -n "$sidecar" && test -x "$sidecar"
  test "$(cat "$package_type")" = deb
  "$sidecar" --help > /dev/null
  command -v git > /dev/null && command -v lsof > /dev/null
'"$libs_check"
for image in debian:12 ubuntu:22.04 ubuntu:24.04; do
  check "DEB install on $image" docker run --rm --platform "$platform" -v "$dist_dir:/pkg:ro" "$image" bash -eu -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq /pkg/$deb > /dev/null
    $deb_check
  "
done

rpm_check='
  sidecar=$(rpm -ql cadencr | grep -E "/resources/cadencr-service$" | head -n1)
  package_type=$(rpm -ql cadencr | grep -E "/resources/package-type$" | head -n1)
  test -n "$sidecar" && test -x "$sidecar"
  test "$(cat "$package_type")" = rpm
  "$sidecar" --help > /dev/null
  command -v git > /dev/null && command -v lsof > /dev/null
'"$libs_check"
check "RPM install on fedora:41" docker run --rm --platform "$platform" -v "$dist_dir:/pkg:ro" fedora:41 bash -eu -c "
  dnf install -y -q /pkg/$rpm > /dev/null
  $rpm_check
"
check "RPM install on rockylinux:9" docker run --rm --platform "$platform" -v "$dist_dir:/pkg:ro" rockylinux:9 bash -eu -c "
  dnf install -y -q /pkg/$rpm > /dev/null
  $rpm_check
"
check "RPM install on opensuse/tumbleweed" docker run --rm --platform "$platform" -v "$dist_dir:/pkg:ro" opensuse/tumbleweed bash -eu -c "
  zypper --non-interactive --quiet install --allow-unsigned-rpm /pkg/$rpm > /dev/null
  $rpm_check
"

if [ "${#failures[@]}" -gt 0 ]; then
  printf 'FAILED: %s\n' "${failures[@]}" >&2
  exit 1
fi
echo "Linux packages passed smoke tests: $appimage, $deb, $rpm"
