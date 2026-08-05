# Linux installer plan

This document captures the Linux packaging and installer decisions discovered
while validating the local Ubuntu build. It is intended as implementation
guidance for the future one-line installer.

## Goal

Provide a Linux install command similar to:

```sh
curl -fsSL https://cadencr.com/install.sh | sh
```

The script should install the best native artifact for the user's distro and
avoid making AppImage the primary path on Ubuntu.

## Preferred install strategy

Use distro packages first:

1. Debian, Ubuntu, Mint, Pop!_OS, elementary, Kali, Raspberry Pi OS:
   download and install the `.deb`.
2. Fedora, RHEL, CentOS, Rocky, AlmaLinux, Amazon Linux, Oracle Linux,
   openSUSE, SLES:
   download and install the `.rpm`.
3. Unknown Linux:
   either fail with a clear unsupported-distro message or offer AppImage as an
   explicit fallback.

AppImage should remain available as a portable fallback, but it should not be
the default for Ubuntu users.

## Why AppImage is not the default

The AppImage build worked, but it exposed three compatibility issues on Ubuntu
26.04:

- FUSE is required. Ubuntu 26.04 provides this as `libfuse2t64`, not
  `libfuse2`.
- Electron can fail with the SUID sandbox helper error when AppImage mounts
  `chrome-sandbox` without `root:root` ownership and mode `4755`.
- Launching with `--no-sandbox` works for local testing, but should not be the
  normal production path when `.deb` and `.rpm` packages are available.

For no-root AppImage testing, extraction works:

```sh
./Cadencr-0.6.4.AppImage --appimage-extract
./squashfs-root/AppRun
```

For local Ubuntu AppImage testing, this was required:

```sh
sudo apt install libfuse2t64
./Cadencr-0.6.4.AppImage --no-sandbox
```

## Release artifact names

Current Linux release workflow is configured to build:

- `Cadencr-<version>.AppImage`
- `Cadencr-<version>-amd64.deb`
- `Cadencr-<version>-x86_64.rpm`

The installer should not hardcode the npm package name into user-facing output.
Electron Builder is configured to use `cadencr` as the native Linux package
name while keeping `Cadencr` as the product and artifact name.

## Build requirements

Before packaging Linux artifacts, build the Rust service sidecar in release
mode:

```sh
pnpm build:local:linux
```

Do not package a debug sidecar. A debug `cadencr-service` loads
`packages/service/.env`, which overrides Electron's generated production auth
token. The symptom is:

```text
Health check failed after 60 retries at http://127.0.0.1:5004
```

The release sidecar does not load the dev `.env`; the AppImage then logs:

```text
Health check passed after 2 retries
```

`pnpm build:local:linux` builds the local Linux AppImage and `.deb` package,
then installs the generated `.deb` with:

```sh
sudo apt install --reinstall -y \
  packages/desktop/dist-electron/Cadencr-<version>-amd64.deb
```

It does not build `.rpm` because that requires `rpm` / `rpmbuild` to be
installed on the local machine; the CI release workflow covers RPM packaging.

## Installer behavior

The installer script should:

1. Use `set -eu`.
2. Reject root execution unless a package-manager operation needs `sudo`.
3. Detect architecture with `uname -m`.
4. Support `x86_64` first. Fail clearly for unsupported architectures.
5. Detect distro from `/etc/os-release`, using `ID` and `ID_LIKE`.
6. Resolve the latest GitHub release unless `CADENCR_VERSION` is set.
7. Download into a temporary directory created by `mktemp -d`.
8. Verify download success and non-empty file size.
9. Install `.deb` with `sudo apt install ./file.deb` or `sudo dpkg -i` followed
   by `sudo apt-get install -f`.
10. Install `.rpm` with `sudo dnf install ./file.rpm`, `sudo yum install`, or
    `sudo zypper install`, depending on the detected package manager.
11. Print the installed command or desktop entry name.
12. Never silently fall back to AppImage when a native package install fails.

Useful environment overrides:

- `CADENCR_VERSION=v0.6.4`
- `CADENCR_INSTALL_CHANNEL=latest`
- `CADENCR_INSTALL_DIR=$HOME/.local/bin` for future AppImage fallback only
- `CADENCR_ASSUME_YES=1`

## Distro detection sketch

```sh
id_value=
id_like_value=

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  id_value=${ID:-}
  id_like_value=${ID_LIKE:-}
fi

case " $id_value $id_like_value " in
  *" debian "*|*" ubuntu "*|*" mint "*|*" pop "*)
    package_format=deb
    ;;
  *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*|*" suse "*|*" opensuse "*)
    package_format=rpm
    ;;
  *)
    package_format=unsupported
    ;;
esac
```

## Runtime notes

Cadencr's packaged Electron shell starts a local `cadencr-service` sidecar on
`127.0.0.1:5004`. During testing, a failed AppImage launch left a stale sidecar
holding that port. The app then failed with:

```text
cadencr-service cannot start because 127.0.0.1:5004 is already in use.
```

Before wide Linux release, consider changing production startup to use an
available loopback port or to more robustly clean up its own stale child
process. A fixed sidecar port makes installer testing and repeated failed
launches more brittle.

## Local validation checklist

After building a Linux artifact:

```sh
sha256sum packages/desktop/dist-electron/Cadencr-*.AppImage
./packages/desktop/dist-electron/Cadencr-*.AppImage --appimage-help
```

For AppImage runtime testing on Ubuntu:

```sh
./packages/desktop/dist-electron/Cadencr-*.AppImage --no-sandbox
tail -n 200 /tmp/cadencr-appimage.log
```

Expected healthy log:

```text
cadencr-service: Cadencr service listening on 127.0.0.1:5004
Health check passed
```

For package-manager artifacts, the release workflow already smoke-tests that
the packaged sidecar exists, is executable, and can run `--help` inside Debian
and Fedora containers. Keep that coverage when adding the installer.
