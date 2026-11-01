# Linux release checklist

Manual pass on real Linux machines before announcing a Linux alpha: run it on the
packages `desktop-linux-release.yml` attached, before setting `LINUX_ALPHA_RELEASE` on
the landing site. Automated layers (unit tests, `scripts/linux-container.sh`, the
workflow's package smoke tests) run first; see [../LINUX_PORTING_PLAN.md](../LINUX_PORTING_PLAN.md).

## Matrix

Cover at least one row per package type and one Wayland session:

| Machine | Session | Package |
|---|---|---|
| Ubuntu 24.04 LTS, GNOME | Wayland | DEB, then AppImage |
| Ubuntu 22.04 LTS | X11 | DEB |
| Fedora (current), KDE Plasma | Wayland | RPM |
| Debian 12 | X11 | DEB |
| Arch or another non-DEB/RPM distro | any | AppImage |

Record GPU and driver (Mesa/NVIDIA) for each row: the terminal's WebGPU path depends on it.

## Install and launch

- [ ] Install with the documented command (`sudo apt install ./…deb`, `sudo dnf install ./…rpm`,
      `chmod +x` + run for the AppImage). `git` and `lsof` are pulled in as dependencies.
- [ ] Launch from the **application menu**, not a terminal (exercises login-shell PATH
      hydration). Icon and name are correct in the dock/taskbar and Alt+Tab.
- [ ] Data lives in `~/.local/share/cadencr`, config in `~/.config/cadencr`, logs/cache in
      `~/.cache/cadencr`; no `~/.cadencr` is created.
- [ ] Quit and relaunch twice; also kill the app (`kill -9`) and relaunch — no
      "port 5004 already in use".

## Agents

- [ ] Each installed CLI is detected (Claude Code, Codex, OpenCode), including one
      installed only in a user dir (`~/.local/bin`, npm global, `~/.cargo/bin`).
- [ ] The Cursor provider plugin installs from the marketplace and runs a turn with the
      `agent` CLI from `~/.local/bin`.
- [ ] Run a short turn per provider (pick small/fast models); approvals and interrupts work.
- [ ] Create a feature with a worktree; edit, diff, commit and push from the Git tab.

## Terminal

- [ ] Note which renderer the terminal uses (WebGPU, or the one-time "compatibility
      terminal" notice).
- [ ] Shell keys reach the shell: Ctrl+D exits a nested shell, Ctrl+W deletes a word,
      Ctrl+R searches history, Ctrl+C interrupts, Ctrl+[ acts as Escape in vim.
- [ ] Terminal actions: Ctrl+Shift+C / Ctrl+Shift+V copy/paste, Ctrl+Shift+D / Ctrl+Alt+D
      split, Ctrl+Shift+W close, Ctrl+Alt+K clear, Ctrl+Shift+Backspace delete line.
- [ ] Global shortcuts still work outside the terminal (Ctrl+K palette, Ctrl+B sidebar).

## Window and desktop integration

- [ ] App-owned window controls: minimize, maximize/restore, close; double-click and drag
      on the header; no overlap with header actions.
- [ ] Embedded browser scrolls without drift (X11 and Wayland sessions).
- [ ] Native notifications on agent completion; clicking one focuses the session.
- [ ] Drag files from the file manager into the prompt; "Show in folder" opens the file
      manager; external links open the default browser.
- [ ] Remote access: pairing QR/URL works from a phone on the LAN (open the port in
      firewalld on Fedora); "Prevent sleep while hosting" keeps the machine awake.

## Updates

- [ ] With two real releases (or pre-releases), the older AppImage, DEB and RPM each detect
      and install the newer one; DEB/RPM prompt for administrator authentication and
      relaunch.

## Uninstall

- [ ] `sudo apt remove cadencr` / `sudo dnf remove cadencr` / delete the AppImage removes
      the app; user data in the XDG dirs is kept.
