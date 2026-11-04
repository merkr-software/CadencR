"""Unpack only a reviewed, closed Node bundle as data; no tar extraction APIs."""
import pathlib
import re
import tarfile
import zlib
from official_plugin_pack import digest, fail, parse_json, relative

MAX_BUNDLE = 32 * 1024 * 1024
FILE_COUNT = 145


def member_path(value):
    relative(value)
    if len(value.encode()) > 240 or not re.fullmatch(r"[A-Za-z0-9_@+./-]+", value):
        fail("invalid reviewed LSP member path")
    return value


def inventory(lock):
    if (not isinstance(lock, dict) or set(lock) != {"schema_version", "package_version", "min_app_version", "node_version", "sources"}
            or type(lock["schema_version"]) is not int or lock["schema_version"] != 1 or not isinstance(lock["sources"], list)
            or len(lock["sources"]) != 2):
        fail("invalid reviewed LSP source lock")
    expected = {}
    sources = {}
    for source in lock["sources"]:
        if not isinstance(source, dict):
            fail("invalid reviewed LSP source declaration")
        name, destination = source.get("name"), source.get("destination")
        if name in sources or {"typescript-language-server": ".", "typescript": "node_modules/typescript"}.get(name) != destination:
            fail("invalid reviewed LSP source identity")
        sources[name] = destination
        if not isinstance(source.get("files"), list) or not source["files"]:
            fail("invalid reviewed LSP source inventory")
        total = 0
        for item in source["files"]:
            if not isinstance(item, dict) or set(item) != {"path", "sha256", "size"}:
                fail("invalid reviewed LSP file declaration")
            path = member_path(item["path"])
            path = path if destination == "." else member_path(destination + "/" + path)
            if (path in expected or type(item["size"]) is not int or not 0 < item["size"] <= MAX_BUNDLE
                    or not isinstance(item["sha256"], str) or not re.fullmatch("[a-f0-9]{64}", item["sha256"])):
                fail("invalid or duplicate reviewed LSP file")
            expected[path] = item
            total += item["size"]
        if type(source.get("expanded_size")) is not int or total != source["expanded_size"]:
            fail("reviewed LSP source inventory size mismatch")
    if set(sources) != {"typescript-language-server", "typescript"} or len(expected) != FILE_COUNT:
        fail("reviewed LSP bundle must bind exactly 145 files")
    if sum(item["size"] for item in expected.values()) > MAX_BUNDLE:
        fail("reviewed LSP bundle exceeds size limit")
    return expected


def decode_bundle(data):
    if not data or len(data) > MAX_BUNDLE:
        fail("reviewed LSP compressed bundle exceeds size limit")
    decoder = zlib.decompressobj(31)
    try:
        expanded = decoder.decompress(data, MAX_BUNDLE + 1)
    except zlib.error:
        fail("reviewed LSP gzip is invalid")
    if len(expanded) > MAX_BUNDLE or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        fail("reviewed LSP gzip is incomplete, oversized or contains trailing content")
    return expanded


def inspect_bundle(data, expected):
    expanded = decode_bundle(data)
    offset, captured = 0, {}
    while offset + 512 <= len(expanded):
        header = expanded[offset:offset + 512]
        if header == bytes(512):
            if expanded[offset:] != bytes(1024):
                fail("reviewed LSP tar has missing terminator or trailing content")
            break
        try:
            info = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        except (tarfile.HeaderError, UnicodeError):
            fail("reviewed LSP tar header is invalid")
        path = member_path(info.name)
        if (header[257:265] != b"ustar\x0000" or info.type != tarfile.REGTYPE
                or info.mode != 0o644 or info.uid != 0 or info.gid != 0 or info.mtime != 0
                or info.uname or info.gname or info.linkname or info.sparse is not None
                or path in captured or path not in expected or info.size != expected[path]["size"]):
            fail("reviewed LSP tar member differs from its closed inventory")
        start, end = offset + 512, offset + 512 + info.size
        padded = start + ((info.size + 511) // 512) * 512
        if padded > len(expanded) or any(expanded[end:padded]):
            fail("reviewed LSP tar member is truncated or has nonzero padding")
        content = expanded[start:end]
        if digest(content) != expected[path]["sha256"]:
            fail("reviewed LSP tar member digest mismatch")
        captured[path] = content
        offset = padded
    else:
        fail("reviewed LSP tar has no complete terminator")
    if set(captured) != set(expected) or list(captured) != sorted(captured):
        fail("reviewed LSP tar inventory is incomplete or unordered")
    return captured


def unpack(stage, destination, version, min_app_version):
    paths = list(stage.iterdir())
    if ({path.name for path in paths} != {"bundle.tar.gz", "source-lock.json"}
            or any(not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o777 != 0o644 for path in paths)):
        fail("reviewed LSP payload must contain only its two regular data files")
    archive = (stage / "bundle.tar.gz").read_bytes()
    lock_bytes = (stage / "source-lock.json").read_bytes()
    if len(lock_bytes) > 1024 * 1024:
        fail("reviewed LSP source lock exceeds size limit")
    lock = parse_json(lock_bytes)
    if lock["package_version"] != version or lock["min_app_version"] != min_app_version or lock["node_version"] != "22.19.0":
        fail("reviewed LSP lock and package versions differ")
    captured = inspect_bundle(archive, inventory(lock))
    destination.mkdir()
    for name, data in captured.items():
        output = destination / pathlib.PurePosixPath(name)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(data)
        output.chmod(0o644)
    return archive
