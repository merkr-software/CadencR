"""Resource bounds, fail-closed export and an opt-in real Linux namespace probe."""
import errno
import io
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import linux_sandbox as sandbox
from bounded_output import BoundedOutput, RUNTIME_FILE_LIMIT


class LinuxSandboxTests(unittest.TestCase):
    def test_launcher_open_error_is_exportable_after_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            (work / "reports").mkdir()
            with patch.object(sandbox.Path, "open", side_effect=OSError(errno.ENOSPC, "full")), \
                 patch.object(sandbox, "reap_candidates") as reap:
                status, error = sandbox.execute_runtime(65534, 65534, work, ["inert"])
            self.assertIsNone(status)
            self.assertIn("Errno 28", error)
            reap.assert_called_once()

    def test_launcher_close_error_preserves_the_observed_runtime_exit(self):
        class BadClose:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self.stream
            def __exit__(self, *_):
                self.stream.close()
                raise OSError(errno.ENOSPC, "flush failed")
        real_open = Path.open
        def opened(path, *args, **kwargs):
            stream = real_open(path, *args, **kwargs)
            return BadClose(stream) if path.name == "stderr.log" else stream
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            (work / "reports").mkdir()
            process = Mock(stdout=io.BytesIO(), stderr=io.BytesIO())
            process.wait.return_value = 23
            with patch.object(sandbox.Path, "open", opened), \
                 patch.object(sandbox.subprocess, "Popen", return_value=process), \
                 patch.object(sandbox, "reap_candidates") as reap:
                status, error = sandbox.execute_runtime(65534, 65534, work, ["inert"])
            self.assertEqual(status, 23)
            self.assertIn("flush failed", error)
            reap.assert_called_once()

    def test_failed_reap_prevents_export_and_root_readwrite_remount(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            (work / "reports").mkdir()
            process = Mock(stdout=io.BytesIO(), stderr=io.BytesIO())
            process.wait.return_value = 0
            with patch.object(sandbox, "require_namespace"), \
                 patch.object(sandbox, "configure_mounts", return_value=work / "export"), \
                 patch.object(sandbox.subprocess, "Popen", return_value=process), \
                 patch.object(sandbox, "reap_candidates", side_effect=TimeoutError("still alive")), \
                 patch.object(sandbox, "export_result") as export, \
                 patch.object(sandbox.subprocess, "run") as remount:
                with self.assertRaisesRegex(TimeoutError, "still alive"):
                    sandbox.run_sandbox(65534, 65534, work, ["inert"])
            export.assert_not_called()
            remount.assert_not_called()

    def test_cleanup_refuses_to_signal_processes_outside_namespace_init(self):
        with patch.object(sandbox.os, "getpid", return_value=42), patch.object(sandbox.os, "kill") as kill:
            with self.assertRaisesRegex(ValueError, "private PID namespace"):
                sandbox.reap_candidates()
            kill.assert_not_called()

    def test_export_refuses_root_and_nested_links_including_dangling_links(self):
        for nested in (False, True):
            with self.subTest(nested=nested), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, destination = root / "source", root / "destination"
                source.mkdir()
                destination.mkdir()
                if nested:
                    (source / "evidence").mkdir()
                    (source / "evidence/link").symlink_to(root / "absent")
                else:
                    (source / "evidence").symlink_to(root / "absent")
                with self.assertRaisesRegex(ValueError, "real directory|links and special"):
                    sandbox.export_evidence(source, destination)

    def test_export_refuses_special_files_and_oversized_regular_files(self):
        for special in (False, True):
            with self.subTest(special=special), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, destination = root / "source", root / "destination"
                (source / "diagnostics").mkdir(parents=True)
                destination.mkdir()
                path = source / "diagnostics/output"
                if special:
                    os.mkfifo(path)
                else:
                    with path.open("wb") as stream:
                        stream.truncate(8 * 1024 ** 2 + 1)
                with self.assertRaises(ValueError):
                    sandbox.export_evidence(source, destination)

    def test_export_error_preserves_the_original_runtime_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            (source / "reports").mkdir(parents=True)
            destination.mkdir()
            (source / "reports/evidence").symlink_to(root / "absent")
            self.assertFalse(sandbox.export_result(source, destination, 23, "original timeout"))
            result = json.loads((destination / "sandbox.json").read_text())
            self.assertEqual(result["runtime_returncode"], 23)
            self.assertEqual(result["runtime_error"], "original timeout")
            self.assertIn("real directory", result["export_error"])
            self.assertEqual(result["final_status"], "failed")

    def test_success_without_a_passing_runtime_report_is_refused(self):
        for value in (None, {}, {"status": "failed"}, {"status": "passed"}):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, destination = root / "source", root / "destination"
                (source / "reports/evidence").mkdir(parents=True)
                destination.mkdir()
                if value is not None:
                    (source / "reports/evidence/runtime.json").write_text(json.dumps(value))
                passed = sandbox.export_result(source, destination, 0, None)
                self.assertEqual(passed, value == {"status": "passed"})
                result = json.loads((destination / "sandbox.json").read_text())
                self.assertEqual(result["runtime_returncode"], 0)

    def test_process_output_retains_a_bounded_tail_without_losing_under_budget_bytes(self):
        destination = io.BytesIO()
        process = subprocess.Popen([sys.executable, "-c", "import os; os.write(2,b'abcdefgh')"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        output = BoundedOutput(process, process.stderr, budget=8, retained=3, destination=destination)
        self.assertEqual(process.wait(timeout=10), 0)
        output.finish()
        self.assertEqual(destination.getvalue(), b"abcdefgh")
        self.assertEqual(output.tail, b"fgh")
        self.assertEqual(output.total, 8)

    def test_process_output_overflow_fails_even_if_the_child_has_already_exited_zero(self):
        destination = io.BytesIO()
        process = subprocess.Popen([sys.executable, "-c", "import os; os.write(2,b'x'*4096)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        process.wait(timeout=10)
        output = BoundedOutput(process, process.stderr, budget=1024, retained=30, destination=destination)
        with self.assertRaisesRegex(ValueError, "output byte budget"):
            output.finish()
        self.assertEqual(len(destination.getvalue()), 1024)
        self.assertEqual(len(output.tail), 30)


def candidate_probe():
    """Runs only through the privileged helper in a disposable private namespace."""
    from isolation import verify_linux_storage
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lsp-native-prepare"))
    from native_semantic import runtime_file_limit
    root = Path("/sandbox-work")
    (root / "runtime").mkdir()
    (root / "reports/evidence").mkdir()
    (root / "reports/diagnostics").mkdir()
    result = {"status": "passed", "scope": "sandbox integration fixture; no catalog qualification",
              "storage": verify_linux_storage(root / "runtime"), "uid": os.geteuid()}
    for path in ("/root/denied", "/var/tmp/denied", "/home/denied"):
        try:
            Path(path).write_text("must fail")
        except OSError:
            pass
        else:
            raise AssertionError("write outside bounded mounts succeeded: " + path)
    # Same-UID child must not recover a host log FD through its parent's /proc entry.
    code = """import os
for fd in (1,2):
 try: stream=os.open('/proc/'+str(os.getppid())+'/fd/'+str(fd),os.O_WRONLY)
 except PermissionError: continue
 else: os.close(stream)  # Pipes are allowed: their root collector enforces the budget.
 links=os.readlink('/proc/'+str(os.getppid())+'/fd/'+str(fd))
 assert links.startswith('pipe:'),links
"""
    subprocess.run([sys.executable, "-c", code], check=True)
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 ** 2, RUNTIME_FILE_LIMIT))
    result["proof_writer_file_limit"] = resource.getrlimit(resource.RLIMIT_FSIZE)
    code = """import json,os,resource
fd=os.memfd_create('doublemapper',os.MFD_CLOEXEC); os.ftruncate(fd,2**41)
print(json.dumps({'size':os.fstat(fd).st_size,'blocks':os.fstat(fd).st_blocks,
                 'file_limit':resource.getrlimit(resource.RLIMIT_FSIZE)}))
"""
    completed = subprocess.run([sys.executable, "-c", code], preexec_fn=runtime_file_limit,
                               capture_output=True, check=True)
    result["anonymous_file"] = json.loads(completed.stdout)
    assert result["anonymous_file"]["file_limit"] == [RUNTIME_FILE_LIMIT, RUNTIME_FILE_LIMIT]
    assert resource.getrlimit(resource.RLIMIT_FSIZE)[0] == 8 * 1024 ** 2
    resource.setrlimit(resource.RLIMIT_FSIZE, (RUNTIME_FILE_LIMIT, RUNTIME_FILE_LIMIT))
    try:
        with Path("/dev/shm/quota-probe").open("wb") as stream:
            for _ in range(17):
                stream.write(b"x" * 1024 ** 2)
    except OSError as error:
        assert error.errno == errno.ENOSPC, error
        result["ordinary_writes"] = "ENOSPC at bounded tmpfs capacity"
    else:
        raise AssertionError("ordinary writes exceeded the tmpfs budget")
    Path("/dev/shm/quota-probe").unlink()
    process = subprocess.Popen([sys.executable, "-c",
        "import os,time; os.setsid(); open('/sandbox-work/setsid-ready','w').write(str(os.getpid())); time.sleep(5); open('/sandbox-work/reports/evidence/escaped','w').write('escaped')"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 5
    while not (root / "setsid-ready").is_file():
        if time.monotonic() >= deadline:
            raise TimeoutError("detached child did not become ready")
        time.sleep(.01)
    result["detached_child_pid"] = process.pid
    (root / "reports/evidence/runtime.json").write_text(json.dumps(result))


if __name__ == "__main__":
    if sys.argv[1:] == ["--candidate-probe"]:
        candidate_probe()
    elif sys.argv[1:] == ["--integration"]:
        sandbox.require_namespace()
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        root = Path("/sandbox-work")
        root.mkdir()
        real_export = sandbox.export_result
        def export_after_reap(work, destination, status, error):
            report = work / "reports/evidence/runtime.json"
            value = json.loads(report.read_text())
            assert not Path("/proc", str(value["detached_child_pid"])).exists(), "descendant survived until export"
            value["descendants_gone_before_export"] = True
            report.write_text(json.dumps(value))
            return real_export(work, destination, status, error)
        sandbox.export_result = export_after_reap
        sys.exit(sandbox.run_sandbox(65534, 65534, root,
            [sys.executable, "-B", str(Path(__file__).resolve()), "--candidate-probe"]))
    else:
        unittest.main()
