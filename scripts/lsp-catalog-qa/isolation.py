"""Fail closed unless the native runner has active network and data-write isolation."""
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys

from handoff import require


def verify_linux_storage(work):
    from linux_sandbox import WORK_BYTES, TEMP_BYTES, DIAGNOSTIC_BYTES, mount_table
    mounts = mount_table()
    root = work.parent.resolve()
    writable = {str(root): WORK_BYTES, str(root / "reports"): DIAGNOSTIC_BYTES,
                "/tmp": TEMP_BYTES, "/dev/shm": 16 * 1024 ** 2}
    require(os.statvfs("/").f_flag & os.ST_RDONLY, "runtime root filesystem must be read-only")
    for path, limit in writable.items():
        entries = [item for item in mounts if item["path"] == path]
        require(entries and entries[-1]["type"] == "tmpfs", "bounded writable tmpfs required: " + path)
        size = next((option[5:] for option in entries[-1]["options"] if option.startswith("size=")), "")
        units = {"k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}
        actual = int(size[:-1]) * units[size[-1]] if size and size[-1] in units else int(size or "0")
        require(0 < actual <= limit, "writable tmpfs exceeds its reviewed size budget")
    for item in mounts:
        if "rw" in item["flags"] and item["path"] not in writable:
            path = Path(item["path"])
            require(path.parent == Path("/root") and path.name.startswith("cadencr-lsp-export-")
                    and not os.access(path, os.W_OK | os.X_OK), "unexpected writable runtime mount: " + str(path))
    return {"root": "read-only", "writable": writable}


def host_target():
    target = {("Linux", "x86_64"): "linux-x86_64", ("Darwin", "arm64"): "darwin-aarch64",
              ("Darwin", "x86_64"): "darwin-x86_64"}.get((platform.system(), platform.machine()))
    require(target is not None, "unsupported native qualification host")
    return target


def verify_source(source_commit):
    from handoff import ROOT
    actual = subprocess.check_output(["/usr/bin/git", "-C", str(ROOT), "rev-parse", "HEAD"],
        env={"PATH": "/usr/bin:/bin"}, timeout=15).decode().strip()
    require(actual == source_commit, "runtime helpers must come from the handoff source commit")


def mac_profile(read_only):
    profile = "(version 1)(allow default)(deny network*)(allow network* (local unix-socket))"
    return profile + "".join("(deny file-write* (subpath " + json.dumps(str(path.resolve())) + "))" for path in read_only)


def verify(read_only, work):
    if sys.platform == "linux":
        require(os.geteuid() != 0, "candidate runtime must not run as root")
        require({name for _, name in socket.if_nameindex()} == {"lo"}, "network namespace must contain only loopback")
        status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
        require(int(status["CapEff"].strip(), 16) == 0 and int(status["CapBnd"].strip(), 16) == 0
                and status["NoNewPrivs"].strip() == "1", "all Linux privileges must be dropped before runtime")
        require(all(os.statvfs(path).f_flag & os.ST_RDONLY for path in read_only), "input and helper mounts must be read-only")
        storage = verify_linux_storage(work)
        return {"network": "unshare-net", "privileges": "setpriv-no-capabilities", "inputs": "read-only-mounts",
                "storage": storage}
    require(sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").is_file(), "active macOS sandbox is required")
    protected = work / "isolation-probe"
    protected.mkdir()
    (protected / "sentinel").write_text("untouched")
    program = '''import pathlib,socket,sys
root=pathlib.Path(sys.argv[1]); unix=socket.socket(socket.AF_UNIX); unix.bind(str(root.parent/'probe.sock')); unix.close()
try:
 socket.socket().bind(('127.0.0.1',0))
except PermissionError:
 pass
else:
 raise SystemExit('IP networking was not denied')
try:
 (root/'sentinel').write_text('changed')
except PermissionError:
 pass
else:
 raise SystemExit('protected writes were not denied')
'''
    result = subprocess.run(["/usr/bin/sandbox-exec", "-p", mac_profile([*read_only, protected]),
        sys.executable, "-c", program, str(protected)], env={"PATH": "/usr/bin:/bin"},
        cwd=work, capture_output=True, timeout=15, check=False)
    require(result.returncode == 0 and (protected / "sentinel").read_text() == "untouched",
            "macOS deny-IP, allow-Unix and read-only-root sandbox probe failed")
    return {"network": "seatbelt-deny-ip-allow-unix", "inputs": "seatbelt-deny-writes", "probe": "passed"}
