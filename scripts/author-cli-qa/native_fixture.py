"""Tracked deterministic native-header inputs; deliberately not runnable programs."""
import json
import struct

TARGETS = ("darwin-aarch64", "darwin-x86_64", "linux-x86_64")
REASONING = "Inert author CLI QA backend; never executed."


def headers():
    def mach_o(cpu, signed):
        commands = [0x1b, 24, 0, 0, 0, 0] + ([0x1d, 16, 0, 0] if signed else [])
        header = [0xfeedfacf, cpu, 0, 2, 2 if signed else 1, len(commands) * 4, 0, 0]
        return struct.pack("<%dI" % (len(header) + len(commands)), *header, *commands)
    return {"darwin-aarch64": mach_o(0x0100000c, True),
            "darwin-x86_64": mach_o(0x01000007, False),
            "linux-x86_64": struct.pack("<16sHH", b"\x7fELF\x02\x01\x01", 2, 62)}


def prepare(source, ui):
    manifest = json.loads((source / "tab.json").read_text())
    manifest["backend"] = {"protocol": 1, "reasoning": REASONING,
        "binary": {target: "bin/" + target + "/backend" for target in TARGETS}}
    for folder in (source, ui):
        (folder / "tab.json").write_text(json.dumps(manifest, sort_keys=True) + "\n")
    for target, data in headers().items():
        path = source / "bin" / target / "backend"
        path.parent.mkdir(parents=True)
        path.write_bytes(data)
        path.chmod(0o755)


def pack(cli, source, stage, descriptor, home, invoke, asset):
    descriptor["backend"] = {"protocol": 1, "reasoning": REASONING}
    binary = descriptor["distribution"]["binary"] = {}
    release = descriptor["distribution"]["archive"].rsplit("/", 1)[0]
    archives = []
    for target in TARGETS:
        output = stage / ("tab-backend-" + target + ".tar.gz")
        receipt = json.loads(invoke(cli, ["registry", "pack-tab-backend", "--directory",
            str(source), "--target", target, "--output", str(output)], home))
        archives.append(asset(output))
        binary[target] = {"archive": release + "/" + output.name,
            **{key: receipt[key] for key in ("sha256", "size", "cmd",
                                            "executable_sha256", "executable_size")}}
    return archives
