"""Trusted deterministic archive orchestration; Rust owns package validation.

Only the pinned CLI executes. Candidate source and native payloads remain data.
"""
import hashlib
import json
import math
import re
import urllib.parse

REPOSITORY = "merkr-software/CadencR"


def fail(message):
    raise SystemExit(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("non-finite JSON number")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite JSON number")
    return number


def parse_json(data):
    return json.loads(data, object_pairs_hook=unique_object,
                      parse_constant=reject_constant, parse_float=finite_float)


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def relative(value):
    if (not isinstance(value, str) or not value or "\\" in value
            or any(part in ("", ".", "..") or part.startswith(".")
                   for part in value.split("/"))):
        fail("invalid reviewed source path")
    return value


def pack(run, work, entry, package, stages, tag, version):
    kind = entry["kind"]
    if kind == "lsp":
        from official_plugin_lsp import pack_lsp
        return pack_lsp(run, work, entry, package, stages, tag, version)
    body = package["package"]
    identity = body["agent" if kind == "provider" else kind]
    distribution = identity.get("distribution", {})
    targets = distribution.get("binary") if kind == "provider" else {kind: distribution}
    if kind == "tab" and "binary" in distribution:
        binary = distribution["binary"]
        if not isinstance(binary, dict):
            fail("invalid reviewed backend targets")
        targets.update({"backend-" + target: value for target, value in binary.items()})
    if not isinstance(targets, dict) or set(targets) != set(stages):
        fail("package targets differ from reviewed payload targets")
    if kind == "tab" and "binary" in distribution:
        # All backend archives belong to the very same immutable UI manifest.
        for target in targets:
            if target != "tab" and ((stages[target] / "tab.json").read_bytes()
                                    != (stages["tab"] / "tab.json").read_bytes()):
                fail("backend payload manifest differs from reviewed UI manifest")
    names = {}
    for target in sorted(stages):
        name = kind + "-" + entry["id"] + "-" + version
        if kind == "provider" or target.startswith("backend-"):
            if not re.fullmatch("[a-z0-9]+-[a-z0-9_]+", target.removeprefix("backend-") if kind == "tab" else target):
                fail("invalid reviewed target")
            name += "-" + target
        name += ".tar.gz"
        selected = targets[target]
        selected["archive"] = ("https://github.com/" + REPOSITORY + "/releases/download/"
                               + urllib.parse.quote(tag, safe="-_.!~*\'()") + "/" + name)
        selected["sha256"] = "0" * 64
        names[target] = name
    archives = []
    for target, stage in sorted(stages.items(), key=lambda item: (item[0] == "tab", item[0])):
        name = names[target]
        selected = targets[target]
        archive = work / name
        first = None
        for index in range(2):
            destination = archive if index == 0 else work / ("repeat-" + name)
            if kind == "tab" and target.startswith("backend-"):
                platform = target.removeprefix("backend-")
                args = ("registry", "pack-tab-backend", "--target", platform)
                receipt_key = {"kind": "tab-backend", "target": platform}
            elif kind == "provider":
                input_path = work / "package-input.json"
                input_path.write_bytes(json_bytes(body))
                args = ("registry", "pack-provider", "--package", str(input_path), "--target", target)
                receipt_key = {"target": target}
            else:
                run("plugin", "validate", str(stage), "--kind", kind, *(("--no-run",) if kind == "tab" else ()))
                args = ("registry", "pack-" + kind)
                if kind == "tab":
                    input_path = work / "tab-package-input.json"
                    input_path.write_bytes(json_bytes(package))
                    args += ("--package", str(input_path))
                receipt_key = {"kind": kind}
            receipt = parse_json(run(*args, "--directory", str(stage), "--output", str(destination)))
            data = destination.read_bytes()
            expected = dict(receipt_key, archive=str(destination), sha256=digest(data), size=len(data))
            if kind == "tab" and target.startswith("backend-"):
                cmd = selected["cmd"]
                executable = (stage / relative(cmd)).read_bytes()
                expected.update(cmd=cmd, executable_sha256=digest(executable), executable_size=len(executable))
            if receipt != expected:
                fail("packaging receipt mismatch")
            if index == 0:
                first = data
                selected["sha256"] = digest(data)
                if kind == "tab" and target.startswith("backend-"):
                    selected.update({key: value for key, value in expected.items() if key in
                                     ("size", "cmd", "executable_sha256", "executable_size")})
            elif first != data:
                fail("nondeterministic canonical packaging")
        archives.append({"target": target, "name": name, "sha256": digest(first), "size": len(first)})
    # Author release requests use the first archive as the primary UI artifact.
    return sorted(archives, key=lambda archive: (archive["target"] != "tab", archive["target"]))
