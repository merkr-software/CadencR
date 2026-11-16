"""Unpack closed reviewed LSP bundles as inert data; no tar extraction APIs."""
import pathlib
import re
import tarfile
import urllib.parse
import unicodedata
import zlib
from official_plugin_pack import digest, fail, parse_json, relative
from official_plugin_tags import SEMVER

MAX_BUNDLE = 32 * 1024 * 1024
FILE_COUNT = 145
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_FILES = 16384
TARGETS = {"linux-x86_64", "darwin-aarch64", "darwin-x86_64"}


def member_path(value):
    relative(value)
    if len(value.encode()) > 240 or not re.fullmatch(r"[A-Za-z0-9_@+./-]+", value):
        fail("invalid reviewed LSP member path")
    return value


def declarative_path(value):
    if not isinstance(value, str) or not value:
        fail("invalid declarative LSP member path")
    try:
        encoded_size = len(value.encode("utf-8"))
    except UnicodeError:
        fail("invalid declarative LSP member encoding")
    if (encoded_size > 240 or any(part in ("", ".", "..") for part in value.split("/"))
            or any(character in "\\:*?\"<>|" or unicodedata.category(character) == "Cc" for character in value)):
        fail("invalid declarative LSP member path")
    for original in value.split("/"):
        part = unicodedata.normalize("NFC", original).lower()
        stem = part.split(".")[0]
        if (len(original.encode("utf-8")) > 128 or part.endswith((".", " ")) or stem in ("con", "prn", "aux", "nul")
                or re.fullmatch(r"(?:com|lpt)[1-9]", stem)):
            fail("non-portable declarative LSP member path")
        if (part in (".env", ".git", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa")
                or part.startswith(".env.") or part.endswith((".key", ".p12", ".pfx", ".pem"))):
            fail("secret-prone declarative LSP member path")
    return value


def legacy_inventory(lock):
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


def inventory(lock):
    if isinstance(lock, dict) and type(lock.get("schema_version")) is int and lock["schema_version"] == 2:
        return declarative_inventory(lock)
    return legacy_inventory(lock)


def sha256(value):
    return isinstance(value, str) and re.fullmatch("[a-f0-9]{64}", value)


def source_declaration(source):
    if (not isinstance(source, dict) or set(source) != {
            "name", "version", "url", "sha256", "destination", "expanded_size", "files"}):
        fail("invalid declarative LSP source declaration")
    if (not isinstance(source["name"], str) or not re.fullmatch(r"[A-Za-z0-9_@+./-]{1,256}", source["name"])
            or not isinstance(source["version"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}", source["version"])
            or not sha256(source["sha256"])):
        fail("invalid declarative LSP source identity")
    if not isinstance(source["url"], str) or len(source["url"]) > 2048:
        fail("invalid declarative LSP source URL")
    url = urllib.parse.urlsplit(source["url"])
    if (url.scheme != "https" or not url.netloc or not url.hostname or url.username or url.password
            or url.query or url.fragment or any(ord(char) <= 32 for char in source["url"])):
        fail("expected credential-free HTTPS LSP source URL")
    destination = source["destination"]
    if destination != ".":
        declarative_path(destination)
    if (not isinstance(source["files"], list) or not source["files"]
            or len(source["files"]) > MAX_FILES or type(source["expanded_size"]) is not int):
        fail("invalid declarative LSP source inventory")
    return destination


def declarative_inventory(lock):
    if (set(lock) != {"schema_version", "id", "package_version", "min_app_version", "runtime", "entry", "target", "sources"}
            or not isinstance(lock["id"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,127}", lock["id"])
            or not isinstance(lock["package_version"], str) or not re.fullmatch(SEMVER, lock["package_version"])
            or not isinstance(lock["min_app_version"], str) or not re.fullmatch(SEMVER, lock["min_app_version"])
            or lock["runtime"] not in ("node", "native") or not isinstance(lock["target"], str)
            or not isinstance(lock["sources"], list)
            or not 0 < len(lock["sources"]) <= MAX_FILES):
        fail("invalid declarative LSP lock")
    entry = declarative_path(lock["entry"])
    if ((lock["runtime"] == "node" and (lock["target"] != "all" or not entry.endswith((".js", ".mjs", ".cjs"))))
            or (lock["runtime"] == "native" and lock["target"] not in TARGETS)):
        fail("invalid declarative LSP runtime, target or entry")
    expected, sources = {}, set()
    for source in lock["sources"]:
        destination = source_declaration(source)
        identity = (source["name"], destination)
        if identity in sources:
            fail("duplicate declarative LSP source")
        sources.add(identity)
        total = 0
        for item in source["files"]:
            if not isinstance(item, dict) or set(item) != {"path", "sha256", "size", "mode"}:
                fail("invalid declarative LSP file declaration")
            path = declarative_path(item["path"])
            path = path if destination == "." else declarative_path(destination + "/" + path)
            mode = "100755" if lock["runtime"] == "native" and path == entry else "100644"
            if (path == "lsp.json" or path in expected or item["mode"] != mode or not sha256(item["sha256"])
                    or type(item["size"]) is not int or not 0 <= item["size"] <= MAX_EXPANDED):
                fail("invalid or duplicate declarative LSP file")
            expected[path] = item
            total += item["size"]
        if total != source["expanded_size"]:
            fail("declarative LSP source inventory size mismatch")
    if (not 0 < len(expected) <= MAX_FILES or sum(item["size"] for item in expected.values()) > MAX_EXPANDED - MAX_FILES * 1024 - 1024
            or entry not in expected or not expected[entry]["size"]):
        fail("declarative LSP inventory exceeds bounds or differs from runtime entry contract")
    portable = {unicodedata.normalize("NFC", path).lower() for path in expected}
    if (len(portable) != len(expected) or any("/".join(unicodedata.normalize("NFC", path).lower().split("/")[:index]) in portable
            for path in expected for index in range(1, len(path.split("/"))))):
        fail("declarative LSP file collides with a parent directory")
    return expected


def decode_bundle(data, expanded_limit=None, archive_limit=None):
    expanded_limit = MAX_BUNDLE if expanded_limit is None else expanded_limit
    archive_limit = MAX_BUNDLE if archive_limit is None else archive_limit
    if not data or len(data) > archive_limit:
        fail("reviewed LSP compressed bundle exceeds size limit")
    decoder = zlib.decompressobj(31)
    try:
        expanded = decoder.decompress(data, expanded_limit + 1)
    except zlib.error:
        fail("reviewed LSP gzip is invalid")
    if len(expanded) > expanded_limit or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        fail("reviewed LSP gzip is incomplete, oversized or contains trailing content")
    return expanded


def inspect_bundle(data, expected, expanded_limit=None, archive_limit=None):
    expanded = decode_bundle(data, expanded_limit, archive_limit)
    offset, captured = 0, {}
    path_check = declarative_path if any("mode" in item for item in expected.values()) else member_path
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
        path = path_check(info.name)
        if (header[257:265] != b"ustar\x0000" or info.type != tarfile.REGTYPE
                or info.mode != (0o755 if expected.get(path, {}).get("mode") == "100755" else 0o644) or info.uid != 0 or info.gid != 0 or info.mtime != 0
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
    order = sorted(captured, key=lambda name: name.split("/")) if path_check == declarative_path else sorted(captured)
    if set(captured) != set(expected) or list(captured) != order:
        fail("reviewed LSP tar inventory is incomplete or unordered")
    return captured


def unpack(stage, destination, version, min_app_version, identity="typescript-language-server", target=None,
           runtime="node", entry="lib/cli.mjs"):
    paths = list(stage.iterdir())
    if ({path.name for path in paths} != {"bundle.tar.gz", "source-lock.json"}
            or any(not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o777 != 0o644 for path in paths)):
        fail("reviewed LSP payload must contain only its two regular data files")
    if (stage / "source-lock.json").stat().st_size > 16 * 1024 * 1024:
        fail("reviewed LSP source lock exceeds size limit")
    lock = parse_json((stage / "source-lock.json").read_bytes())
    expected = inventory(lock)
    if lock["package_version"] != version or lock["min_app_version"] != min_app_version:
        fail("reviewed LSP lock and package versions differ")
    legacy = lock["schema_version"] == 1
    if legacy:
        if (stage / "source-lock.json").stat().st_size > 1024 * 1024:
            fail("legacy reviewed LSP source lock exceeds size limit")
        if (identity != "typescript-language-server" or version != "0.1.0" or runtime != "node"
                or entry != "lib/cli.mjs" or lock["node_version"] != "22.19.0"):
            fail("legacy LSP lock is restricted to the original TypeScript release")
    elif (lock["id"] != identity or lock["runtime"] != runtime or lock["entry"] != entry
            or (runtime == "native" and lock["target"] != target)):
        fail("declarative LSP lock differs from reviewed package identity, runtime, entry or target")
    limit = MAX_BUNDLE if legacy else MAX_ARCHIVE
    if (stage / "bundle.tar.gz").stat().st_size > limit:
        fail("reviewed LSP compressed bundle exceeds size limit")
    archive = (stage / "bundle.tar.gz").read_bytes()
    captured = inspect_bundle(archive, expected, MAX_BUNDLE if legacy else MAX_EXPANDED, limit)
    destination.mkdir()
    for name, data in captured.items():
        output = destination / pathlib.PurePosixPath(name)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(data)
        output.chmod(0o755 if expected[name].get("mode") == "100755" else 0o644)
    return archive
