"""Official LSP preparation from reviewed Git blob data and Rust CLI receipts."""
from official_plugin_pack import REPOSITORY, digest, fail, json_bytes, parse_json

TARGETS = {"linux-x86_64", "darwin-aarch64", "darwin-x86_64"}
ENTRY = "lib/cli.mjs"


def pack_lsp(run, work, entry, package, stages, tag, version):
    from official_plugin_lsp_archive import unpack
    body = package["package"]
    targets = body["lsp"]["distribution"]["binary"]
    if set(targets) != TARGETS or set(stages) != TARGETS:
        fail("LSP package targets differ from the reviewed three payload targets")
    first = stages[sorted(stages)[0]]
    for stage in stages.values():
        for name in ("bundle.tar.gz", "source-lock.json"):
            if (stage / name).read_bytes() != (first / name).read_bytes():
                fail("reviewed LSP target data differs")
    runtime = work / "lsp-runtime"
    canonical = unpack(first, runtime, version, body["host"]["compatibility"]["min_app_version"])
    executable = (runtime / ENTRY).read_bytes()
    archives = []
    for target in sorted(targets):
        selected = targets[target]
        name = "lsp-" + entry["id"] + "-" + version + "-" + target + ".tar.gz"
        bound = {"archive": "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + name,
                 "sha256": digest(canonical), "size": len(canonical), "entry": ENTRY,
                 "entry_sha256": digest(executable), "entry_size": len(executable), "runtime": "node"}
        if selected != bound:
            fail("reviewed LSP package differs from qualified archive and entry bindings")
        for index in range(2):
            output = work / (name if index == 0 else "repeat-" + name)
            receipt = parse_json(run("registry", "pack-lsp", "--directory", str(runtime),
                "--target", target, "--runtime", "node", "--entry", ENTRY, "--output", str(output)))
            data = output.read_bytes()
            expected = {**bound, "kind": "lsp", "target": target, "archive": str(output)}
            if receipt != expected:
                fail("LSP packaging receipt mismatch")
            if data != canonical:
                fail("Rust LSP archive differs from the reviewed canonical bundle")
        archives.append({"target": target, "name": name, "sha256": bound["sha256"], "size": bound["size"]})
    # Metadata is introduced only after all six canonical archives were captured.
    (runtime / "lsp.json").write_bytes(json_bytes(package))
    run("plugin", "validate", str(runtime), "--kind", "lsp")
    return archives
