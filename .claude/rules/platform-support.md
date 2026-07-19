CadencR Desktop is a supported product on both macOS and Linux. Treat both platforms as first-class whenever changing shared application behavior.

- Prefer platform-neutral implementations. For filesystem paths, process spawning, shell commands, executable discovery, keyboard modifiers, updater behavior, packaging, native dialogs, window chrome, and Electron/runtime integration, explicitly evaluate the behavior on both macOS and Linux.
- Add automated coverage for every platform-specific branch whenever practical. Keep platform detection at a narrow boundary instead of scattering OS checks through shared code.
- Before reporting work complete, explicitly tell the user which macOS- and Linux-specific tests were run, which were automated, and which still require validation on a real platform or packaged artifact. Never imply that a test on one operating system proves behavior on the other.
- If a change requires a dedicated platform test that cannot be run in the current environment, call that out clearly as a remaining verification requirement rather than silently omitting it.
