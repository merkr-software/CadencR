# Linux porting plan

Status of the Linux desktop port and how it is tested. Companion docs:
[LINUX_SETUP.md](./LINUX_SETUP.md) (run from source), [LINUX_INSTALLER_PLAN.md](./LINUX_INSTALLER_PLAN.md)
(future `install.sh`), [qa/LINUX_RELEASE_CHECKLIST.md](./qa/LINUX_RELEASE_CHECKLIST.md)
(manual pass before a release).

Scope: x86-64 AppImage, DEB and RPM shipped from the release workflow; arm64 builds
locally (Docker on Apple Silicon) for testing. Windows is out of scope.

## Done

| Area | What |
|---|---|
| Paths | XDG data/config/cache through `shared::app_paths` (Rust) and `electron/main/app-paths.ts`; LSP installs, forge tokens and remote-access credentials no longer bypass it. |
| Agent discovery | Login-shell env hydration on Linux (shell from the passwd database), Linux install dirs (`/usr/bin`, `/snap/bin`, `~/.cargo/bin`, `~/.local/share/pnpm`). |
| Packaging | Per-arch sidecar staging (`@cadencr/service build:sidecars`), ELF-arch guard in `after-pack`, AppImage/DEB/RPM with arch-suffixed names, `git` + `lsof` package dependencies, soname-based RPM dependencies (install on Fedora, RHEL/Rocky and openSUSE alike), Linux window icon. |
| Release | Linux ships as a manual alpha: after `desktop-release.yml` publishes macOS, `desktop-linux-release.yml` (run by hand) builds the tag on `ubuntu-22.04` (glibc 2.35), smoke tests it, attaches the packages and flags the notes "Linux (alpha)". `latest-linux.yml` drives AppImage/DEB/RPM auto-updates; a release without it reads as "no update" on Linux. |
| Window chrome | Frameless window with app-owned controls; X11 forced by default (Wayland `WebContentsView` scroll drift). |
| Keyboard | Bare Ctrl chords belong to the shell while the terminal has focus; terminal actions use Ctrl+Shift/Ctrl+Alt off macOS; platform-aware hint labels. |
| Runtime | AppImage/Electron variables stripped from the sidecar env; sleep prevention while hosting; compatibility-terminal notice once per session; non-mac Edit menu without accelerators that steal Ctrl keys. |
| Landing | Linux downloads and claims hidden until `LINUX_ALPHA_RELEASE` names the release carrying the alpha; shown with an "Alpha" badge. |

## Remaining work

Ordered by what blocks a first public Linux release.

- [ ] **Publish the first Linux alpha.** Once a desktop release is published, run
      `gh workflow run desktop-linux-release.yml -f release_tag=vX.Y.Z`, then the manual
      checklist, then set `LINUX_ALPHA_RELEASE` in `packages/landing/src/lib/downloads.ts`.
- [ ] **Leave alpha.** Fold the Linux build back into `desktop-release.yml` once Linux
      should ship with every release.
- [ ] **WebGPU terminal on real GPUs.** Xvfb has no adapter, so CI cannot tell whether
      celeritty renders on Mesa/NVIDIA under X11. Measure on real machines; decide on
      an Electron GPU switch or keep the xterm fallback.
- [ ] **AppImage sandbox on Ubuntu 24.04+.** AppArmor's unprivileged-userns restriction
      can abort the AppImage (`chrome-sandbox` SUID error). DEB/RPM ship an AppArmor
      profile; the AppImage needs a documented workaround or a launcher fix.
- [ ] **Wayland.** The `ozone-platform=x11` switch does reach Chromium (seen on the GPU
      process under Xvfb); confirm it on a real Wayland session, else move it to
      `linux.executableArgs`.
- [ ] **Fixed sidecar port 5004.** A stale sidecar from a crashed launch blocks the next one
      (`127.0.0.1:5004 is already in use`). Pick a free port per launch or reclaim our own child.
- [ ] **inotify limits.** Recursive watchers now surface an actionable error on exhaustion;
      a polling fallback for huge monorepos is still open.
- [ ] **`RLIMIT_AS` on managed providers.** The 16 GiB address-space cap may break Bun- or
      wasm-based ACP agents on Linux; test one and switch to a cgroup limit if needed.
- [ ] **Linux arm64 releases.** DEB/RPM build, install and launch locally; not in the release
      matrix or landing yet. Blockers: electron-builder's arm64 AppImage runtime
      (`appimage-12.0.1`) links `libz.so` instead of `libz.so.1`, so the AppImage only starts
      where zlib's dev package is installed; and tab backends have no `linux-aarch64` target,
      which also makes ~35 `plugin_tabs` / `registry-core` tests fail on arm64 Linux by design.
- [ ] **Firewall/LAN hints for remote access** (firewalld blocks the port on Fedora by default).

## Test strategy

Four layers; each catches what the previous cannot.

1. **Unit tests with an injected platform — every PR, both OSes.** Platform branches take
   the OS (or env) as a parameter so macOS developers run the Linux branch and vice versa
   (`childProcessEnv(env, platform)`, `isShellControlChord(event, isMac)`,
   `detectLinuxInstallType(env, path)`). Never read `process.platform` in a test without
   simulating it. CI runs the Rust and vitest suites on `ubuntu-latest`, which also
   executes `cfg(target_os = "linux")` code that macOS cannot compile.
2. **Linux container on a developer machine — before pushing Linux-sensitive changes.**
   `scripts/linux-container.sh` builds a Debian 12 image and runs, on the host's arch
   (arm64 natively on Apple Silicon):
   - `rust-test`, `clippy`, `vitest` — the same suites as CI, on Linux;
   - `package` — release sidecar + AppImage/DEB/RPM;
   - `smoke` — `scripts/smoke-linux-packages.sh`: AppImage payload, real DEB installs
     on Debian 12 / Ubuntu 22.04 / 24.04, RPM installs on Fedora, Rocky 9 and openSUSE, every
     library the Electron binary links resolving (`ldd`), updater package identity,
     `latest-linux.yml` entries;
   - `e2e` — `scripts/linux-container/e2e-launch.mjs` boots the installed DEB and the
     AppImage (FUSE-mounted when the Docker host has `/dev/fuse`, extracted otherwise) under Xvfb with an empty `HOME` and checks over CDP that the window loads,
     the sidecar answers authenticated `/api/health`, data lands under XDG (never
     `~/.cadencr`), app-owned window controls are on, and no AppImage variable reaches
     the sidecar.
3. **Linux alpha workflow — every Linux release, by hand.** `desktop-linux-release.yml`
   refuses a draft or already-Linux release, builds x64 on `ubuntu-22.04`, smoke tests the
   sidecar, runs `smoke-linux-packages.sh`, then uploads and verifies every Linux asset.
4. **Manual pass on real machines — every release candidate.** What containers cannot
   show: GPU rendering, Wayland/X11 sessions, desktop integration (menu entry, icon,
   notifications, file drops), AppArmor, the update chain across two real versions.
   Follow [qa/LINUX_RELEASE_CHECKLIST.md](./qa/LINUX_RELEASE_CHECKLIST.md).

## Verification log

**2026-10-23**, branch `feature/plan-linux-porting-and-testing-a98a` rebased on `main`:

- macOS host (Apple Silicon): full desktop vitest (6400+), landing tests, root script tests,
  workspace Rust tests via pre-commit; dev app QA on a fresh DB (global shortcuts,
  terminal pane shortcuts, command-palette pane actions, remote-access sleep toggle; macOS
  data paths unchanged under `~/.cadencr`).
- Linux arm64 (Docker, Debian 12) via `scripts/linux-container.sh`:
  - `vitest`: desktop and landing suites pass.
  - `clippy`: clean, including `cfg(target_os = "linux")` code.
  - `rust-test`: all pass except the arm64-only tab-backend tests above.
  - `package` + `smoke`: DEB installs and its sidecar runs on Debian 12 and Ubuntu
    22.04/24.04; RPM on Fedora 41, Rocky Linux 9 and openSUSE Tumbleweed; the arm64 AppImage
    hits the runtime `libz.so` issue.
  - `e2e`: DEB and FUSE-mounted AppImage launch, sidecar healthy, XDG paths, no
    `~/.cadencr`, app-owned window controls, clean sidecar environment. No WebGPU adapter
    under Xvfb (xterm fallback).
- Not yet run: `desktop-linux-release.yml` (first run happens on a published release), and every item of
  the [manual checklist](./qa/LINUX_RELEASE_CHECKLIST.md).
