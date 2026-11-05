"""Explicit reviewed transformations of upstream native executable bytes."""
from pathlib import Path
import struct
import subprocess
import tempfile


def macho_slice(data, target):
    cpu = {"darwin-aarch64": 0x100000c, "darwin-x86_64": 0x1000007}[target]
    if data[:4] != b"\xca\xfe\xba\xbe":
        raise ValueError("expected 32-bit-header universal Mach-O")
    count = struct.unpack_from(">I", data, 4)[0]
    if not 0 < count <= 16 or len(data) < 8 + count * 20:
        raise ValueError("invalid universal Mach-O table")
    matches = []
    for index in range(count):
        arch, _, offset, size, _ = struct.unpack_from(">IIIII", data, 8 + index * 20)
        if offset < 8 + count * 20 or not size or offset + size > len(data):
            raise ValueError("invalid universal Mach-O slice bounds")
        if arch == cpu:
            matches.append(data[offset:offset + size])
    if len(matches) != 1:
        raise ValueError("target Mach-O slice must be unique")
    return matches[0]


def transform(data, spec, target, strip_program=None):
    kind = spec.get("transform")
    if kind is None:
        return data
    if kind == "macho-thin":
        return macho_slice(data, target)
    if kind != "gnu-strip-debug-2.42" or not strip_program:
        raise ValueError("transformation requires explicit GNU strip 2.42 path")
    program = str(Path(strip_program).resolve(strict=True))
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C"}
    version = subprocess.run([program, "--version"], check=True, capture_output=True, env=env).stdout
    if b"GNU" not in version.splitlines()[0] or not version.splitlines()[0].endswith(b" 2.42"):
        raise ValueError("reviewed transformation requires GNU strip 2.42")
    with tempfile.TemporaryDirectory(prefix="cadencr-strip-") as directory:
        source, output = Path(directory) / "source", Path(directory) / "output"
        source.write_bytes(data)
        subprocess.run([program, "--strip-debug", "--output", str(output), str(source)],
                       check=True, capture_output=True, env=env)
        return output.read_bytes()
