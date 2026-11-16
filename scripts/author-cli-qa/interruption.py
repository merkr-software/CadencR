"""Actual draft interruption only; never claims mutation-response loss."""
from process_limits import bounded_command
import subprocess
import tempfile
import time
from proxy import Gate


def interrupt(cli, args, home, token, network, c, sha, env_builder, require):
    expected_body = ("Inert original-author CLI qualification.\n\n"
                     "<!-- cadencr-publication-binding:sha256:" + sha + " -->")
    deadline = time.monotonic() + 60
    require(network.draft(c, token, deadline=deadline) is None)
    with Gate() as gate, tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        env = gate.environment(env_builder(home, token))
        process = subprocess.Popen(bounded_command(cli, args, 1024*1024), cwd=home, env=env,
                                   stdout=out, stderr=err)
        observed = None
        try:
            while time.monotonic() < deadline and process.poll() is None:
                require(not gate.transport_failed.is_set())
                require(out.tell() <= 1024*1024 and err.tell() <= 1024*1024)
                if gate.api_seen.is_set() and gate.upload_held.is_set():
                    observed = network.draft(c, token, deadline=deadline)
                    if observed is not None:
                        require(observed["draft"] is True
                                and observed["prerelease"] is True
                                and observed["tag_name"] == c["tag"]
                                and observed["target_commitish"] == c["source_commit"]
                                and observed["body"] == expected_body
                                and type(observed["id"]) is int and observed["id"] > 0)
                        assets = network.get("/repos/" + c["repository"] + "/releases/" +
                                             str(observed["id"]) + "/assets?per_page=100", token, deadline=deadline)
                        require(assets == [] and process.poll() is None
                                and time.monotonic() < deadline
                                and not gate.transport_failed.is_set())
                        break
                time.sleep(0.2)
            require(observed is not None and gate.api_seen.is_set()
                    and gate.upload_held.is_set() and process.poll() is None
                    and time.monotonic() < deadline and not gate.transport_failed.is_set())
        finally:
            # Only this exact child PID is signalled, never process-name matching.
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        return observed["id"]
