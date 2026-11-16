"""Bounded selected-member reads. Upstream archives are never extracted to disk."""
import gzip
import hashlib
import io
from pathlib import PurePosixPath
import struct
import tarfile
import zipfile

MAX_DOWNLOAD = 160 * 1024 * 1024
MAX_EXECUTABLE = 252 * 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def bounded(stream, limit):
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"content exceeds {limit} byte budget")
    return data


def safe_name(name):
    path = PurePosixPath(name)
    return (bool(name) and not path.is_absolute() and "\\" not in name
            and all(part not in (".", "..", "") for part in name.split("/")))


def executable(data, target):
    """Check architecture before any optional execution, including universal Mach-O."""
    if target == "linux-x86_64":
        if len(data) < 20 or data[:6] != b"\x7fELF\x02\x01" or data[18:20] != b"\x3e\x00":
            raise ValueError("expected Linux x86_64 ELF executable")
        return
    cpu = {"darwin-aarch64": 0x100000c, "darwin-x86_64": 0x1000007}[target]
    if len(data) >= 8 and data[:4] == b"\xcf\xfa\xed\xfe":
        if struct.unpack_from("<I", data, 4)[0] == cpu:
            return
    if len(data) >= 8 and data[:4] in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        count = struct.unpack_from(">I", data, 4)[0]
        stride = 32 if data[:4] == b"\xca\xfe\xba\xbf" else 20
        if count <= 16 and len(data) >= 8 + count * stride:
            if cpu in [struct.unpack_from(">I", data, 8 + n * stride)[0] for n in range(count)]:
                return
    raise ValueError(f"expected {target} Mach-O executable")


def selected(data, kind, member):
    if kind == "raw":
        return bounded(io.BytesIO(data), MAX_EXECUTABLE)
    if kind == "gz":
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            return bounded(stream, MAX_EXECUTABLE)
    if not safe_name(member):
        raise ValueError("unsafe selected member")
    if kind == "tar.gz":
        with tarfile.open(fileobj=io.BytesIO(data), mode="r|gz") as archive:
            found = None
            total = 0
            for index, entry in enumerate(archive):
                total += entry.size
                if index >= 20000 or total > 512 * 1024 * 1024:
                    raise ValueError("upstream archive inventory exceeds budget")
                if entry.name == member:
                    if found is not None or not entry.isfile():
                        raise ValueError("selected member must be a unique regular file")
                    found = bounded(archive.extractfile(entry), MAX_EXECUTABLE)
            if found is None:
                raise ValueError("selected member missing")
            return found
    if kind == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            matches = [entry for entry in entries if entry.filename == member]
            if len(entries) > 20000 or sum(e.file_size for e in entries) > 512 * 1024 * 1024:
                raise ValueError("upstream archive inventory exceeds budget")
            if len(matches) != 1 or matches[0].is_dir() or (matches[0].external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("selected member must be a unique regular file")
            with archive.open(matches[0]) as stream:
                return bounded(stream, MAX_EXECUTABLE)
    raise ValueError(f"unsupported source format: {kind}")


def retained(data, spec):
    """Retain an audited subtree of regular data plus exactly one executable."""
    if not spec.get("retain_tree"):
        return {spec["entry"]: selected(data, spec["format"], spec["member"])}
    prefix = spec.get("strip_prefix", "")
    files = {}
    total = 0

    def keep(name, size, stream):
        nonlocal total
        if not name.startswith(prefix):
            raise ValueError("member lies outside reviewed subtree")
        name = name[len(prefix):]
        if name in spec.get("omit_files", []):
            return
        if spec.get("retain_prefixes") and not any(name.startswith(p) for p in spec["retain_prefixes"]):
            return
        if not safe_name(name) or name in files:
            raise ValueError("unsafe or duplicate retained path")
        total += size
        if total > MAX_EXECUTABLE or len(files) >= 16384:
            raise ValueError("retained tree exceeds package budget")
        content = bounded(stream, min(MAX_EXECUTABLE, size))
        if len(content) != size:
            raise ValueError("retained member size mismatch")
        # Executable companions, including loadable native libraries, are forbidden.
        if name != spec["entry"] and (content[:2] == b"MZ" or content[:4] in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xce", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf")):
            raise ValueError(f"native companion is forbidden: {name}")
        files[name] = content

    if spec["format"] == "tar.gz":
        with tarfile.open(fileobj=io.BytesIO(data), mode="r|gz") as archive:
            scanned = 0
            for index, entry in enumerate(archive):
                scanned += entry.size
                if index >= 20000 or scanned > 512 * 1024 * 1024:
                    raise ValueError("upstream archive inventory exceeds budget")
                if entry.isdir():
                    continue
                if not entry.isfile():
                    raise ValueError("retained tree contains a link or special member")
                keep(entry.name, entry.size, archive.extractfile(entry))
    elif spec["format"] == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 20000 or sum(e.file_size for e in entries) > 512 * 1024 * 1024:
                raise ValueError("upstream archive inventory exceeds budget")
            for entry in entries:
                if entry.is_dir():
                    continue
                if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("retained tree contains a symlink")
                with archive.open(entry) as stream:
                    keep(entry.filename, entry.file_size, stream)
    else:
        raise ValueError("retained trees require tar.gz or zip")
    return files
