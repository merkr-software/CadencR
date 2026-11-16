"""Privileged namespace setup, bounded writable mounts and safe evidence export."""
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lsp-catalog-prepare"))
from bounded_output import BoundedOutput, RUNTIME_FILE_LIMIT


WORK_BYTES = 2 * 1024 ** 3
TEMP_BYTES = 512 * 1024 ** 2
DIAGNOSTIC_BYTES = 128 * 1024 ** 2
EXPORT_BYTES = DIAGNOSTIC_BYTES + 2 * 1024 ** 2


def mount_table():
    records = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        left, right = line.split(" - ", 1)
        fields, filesystem = left.split(), right.split()
        path = fields[4]
        for encoded, decoded in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
            path = path.replace(encoded, decoded)
        try:
            major, minor = map(int, fields[2].split(":"))
            if os.stat(path).st_dev != os.makedev(major, minor):
                continue  # A newer mount hides this entry (notably --mount-proc).
        except PermissionError:
            pass  # The privileged export remains visible in mountinfo but inaccessible.
        records.append({"path": path, "type": filesystem[0],
                        "flags": fields[5].split(","),
                        "options": fields[5].split(",") + filesystem[2].split(",")})
    return records


def require_namespace():
    if os.getpid() != 1 or os.geteuid() != 0:
        raise ValueError("sandbox setup and cleanup require root as private PID namespace init")
    if Path("/proc/1/ns/pid").stat().st_ino != Path("/proc/self/ns/pid").stat().st_ino:
        raise ValueError("/proc must describe the private PID namespace")
    if Path("/proc/self/ns/pid").stat().st_ino == 0xEFFFFFFC:
        raise ValueError("initial host PID namespace refused")


def reap_candidates():
    require_namespace()
    # Linux excludes namespace PID1 from kill(-1). Never call this outside that namespace.
    try:
        os.kill(-1, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 10
    while True:
        try:
            child, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if not child:
            if time.monotonic() >= deadline:
                raise TimeoutError("candidate descendants did not terminate before export")
            time.sleep(.01)


def export_evidence(work, destination):
    """Only export bounded regular reports after all candidate descendants are gone."""
    total, count = 0, 0
    for name in ("evidence", "diagnostics", "launcher"):
        source = work / name
        if source.is_symlink():
            raise ValueError("evidence root must be a real directory")
        if not source.exists():
            continue
        if not source.is_dir():
            raise ValueError("evidence root must be a real directory")
        for folder, directories, files in os.walk(source, followlinks=False):
            for child in [*directories, *files]:
                path = Path(folder) / child
                mode = path.lstat().st_mode
                if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                    raise ValueError("evidence links and special files refused")
                count += 1
                if count > 4096:
                    raise ValueError("evidence file count exceeded")
                if stat.S_ISREG(mode):
                    size = path.stat().st_size
                    total += size
                    if size > 8 * 1024 ** 2 or total > EXPORT_BYTES:
                        raise ValueError("evidence export byte budget exceeded")
        target = destination / ("diagnostics/launcher" if name == "launcher" else name)
        shutil.copytree(source, target)
        for folder, directories, files in os.walk(target):
            Path(folder).chmod(0o755)
            for filename in files:
                (Path(folder) / filename).chmod(0o644)


def tmpfs(path, size, uid, gid, mode="0700", inodes=65536):
    subprocess.run(["mount", "-t", "tmpfs", "-o",
                    f"size={size},nr_inodes={inodes},nosuid,nodev,mode={mode},uid={uid},gid={gid}",
                    "tmpfs", str(path)], check=True)


def configure_mounts(work, uid, gid):
    mounts = mount_table()
    private_parent = Path("/root").lstat()
    if not stat.S_ISDIR(private_parent.st_mode) or private_parent.st_uid != 0 or private_parent.st_mode & 0o077:
        raise ValueError("export parent must be a real root-owned owner-only directory")
    export = Path(tempfile.mkdtemp(prefix="cadencr-lsp-export-", dir="/root"))
    subprocess.run(["mount", "--bind", str(work), str(export)], check=True)
    # Bind-remount changes mount flags only, preserving the private export's RW mount.
    for path in sorted({item["path"] for item in mounts}, key=len, reverse=True):
        subprocess.run(["mount", "-o", "remount,bind,ro", path], check=True)
    tmpfs(work, WORK_BYTES, uid, gid, inodes=131072)
    tmpfs(Path("/tmp"), TEMP_BYTES, uid, gid, "1777")
    tmpfs(Path("/dev/shm"), 16 * 1024 ** 2, uid, gid, "1777")
    (work / "reports").mkdir()
    tmpfs(work / "reports", DIAGNOSTIC_BYTES, 0, 0, "1777")
    return export


def execute_runtime(uid, gid, work, command):
    status, error = None, None
    collectors = []
    reaping, reaped = False, False
    launcher = work / "reports/launcher"
    try:
        launcher.mkdir(mode=0o700)
        with (launcher / "stdout.log").open("xb") as stdout, (launcher / "stderr.log").open("xb") as stderr:
            os.fchmod(stdout.fileno(), 0o600)
            os.fchmod(stderr.fileno(), 0o600)
            try:
                process = subprocess.Popen(["setpriv", "--reuid", str(uid), "--regid", str(gid), "--clear-groups",
                    "--bounding-set=-all", "--no-new-privs", "env", "-i", "PATH=/usr/bin:/bin",
                    f"HOME={work}", f"TMPDIR={work}", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", *map(str, command)],
                    cwd=work, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    start_new_session=True,
                    preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (RUNTIME_FILE_LIMIT, RUNTIME_FILE_LIMIT)))
                collectors = [BoundedOutput(process, process.stdout, destination=stdout, label="runtime stdout"),
                              BoundedOutput(process, process.stderr, destination=stderr, label="runtime stderr")]
                status = process.wait(timeout=2400)
            except (Exception, KeyboardInterrupt) as failure:
                error = type(failure).__name__ + ": " + str(failure)
            finally:
                # Includes fork/setsid descendants adopted by PID1, not just a process group.
                reaping = True
                reap_candidates()
                reaped = True
                for collector in collectors:
                    try:
                        collector.finish()
                    except ValueError as failure:
                        error = (error + "; " if error else "") + str(failure)
    except (Exception, KeyboardInterrupt) as failure:
        if reaping and not reaped:
            raise  # Never export or remount RW after a failed reap.
        if not reaped:
            reap_candidates()
        error = (error + "; " if error else "") + type(failure).__name__ + ": " + str(failure)
    return status, error


def export_result(work, export, runtime_status, runtime_error):
    export_error = None
    try:
        export_evidence(work / "reports", export)
        report = export / "evidence/runtime.json"
        if runtime_status == 0 and (not report.is_file() or report.is_symlink()):
            raise ValueError("successful runtime must export its regular runtime.json proof")
        if runtime_status == 0 and json.loads(report.read_text()).get("status") != "passed":
            raise ValueError("successful runtime must export its passing runtime.json proof")
    except Exception as failure:
        export_error = type(failure).__name__ + ": " + str(failure)
    passed = runtime_status == 0 and runtime_error is None and export_error is None
    (export / "sandbox.json").write_text(json.dumps({"runtime_returncode": runtime_status,
        "final_status": "passed" if passed else "failed", "runtime_error": runtime_error,
        "export_error": export_error, "descendants_reaped": True, "root": "read-only",
        "work_bytes": WORK_BYTES, "temporary_bytes": TEMP_BYTES, "diagnostic_bytes": DIAGNOSTIC_BYTES}) + "\n")
    (export / "sandbox.json").chmod(0o644)
    return passed


def run_sandbox(uid, gid, work, command):
    require_namespace()
    if uid <= 0 or gid < 0 or not work.is_absolute() or work.is_symlink():
        raise ValueError("nonroot identity and an absolute real work directory required")
    export = configure_mounts(work, uid, gid)
    runtime_status, runtime_error = execute_runtime(uid, gid, work, command)
    passed = export_result(work, export, runtime_status, runtime_error)
    # No candidate remains when the parent's root mount becomes writable for cleanup.
    subprocess.run(["mount", "-o", "remount,bind,rw", "/"], check=True)
    subprocess.run(["umount", str(export)], check=True)
    export.rmdir()
    if passed:
        return 0
    return (runtime_status if runtime_status > 0 else 128 - runtime_status) if runtime_status else 1


def main(values):
    if len(values) != 10:
        raise ValueError("expected uid, gid, checkout, handoff, prerequisites, work and source receipts")
    uid, gid = map(int, values[:2])
    checkout, handoff, prerequisites, work = map(Path, values[2:6])
    manifest, source, prerequisite, node_root = values[6:]
    if any(path == Path("/tmp") or Path("/tmp") in path.parents
           for path in (checkout, handoff, prerequisites, work, Path(node_root))):
        raise ValueError("read-only inputs and work must be outside the private /tmp mount")
    command = ["/usr/bin/python3", "-B", checkout / "scripts/lsp-catalog-qa/runtime.py",
        "--handoff", handoff, "--manifest-sha256", manifest, "--source-commit", source,
        "--target", "linux-x86_64", "--prerequisites", prerequisites,
        "--prerequisites-sha256", prerequisite, "--work", work / "runtime",
        "--evidence", work / "reports/evidence", "--diagnostics", work / "reports/diagnostics"]
    def interrupted(*_):
        raise KeyboardInterrupt("sandbox interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    return run_sandbox(uid, gid, work, command)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
