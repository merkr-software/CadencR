"""Official LSP preparation from reviewed Git blob data and Rust CLI receipts."""
import re
from official_plugin_pack import REPOSITORY, digest, fail, json_bytes, parse_json
from official_plugin_tags import SEMVER

TARGETS = {"linux-x86_64", "darwin-aarch64", "darwin-x86_64"}


def runtime_payload(work, entry, body, stages, targets, version):
    from official_plugin_lsp_archive import unpack
    prepared, common = {}, None
    for index, target in enumerate(sorted(targets)):
        selected = targets[target]
        if not isinstance(selected, dict) or selected.get("runtime") not in ("node", "native"):
            fail("invalid reviewed LSP runtime")
        stage = stages[target]
        signature = tuple((stage / name).read_bytes() for name in ("bundle.tar.gz", "source-lock.json"))
        if selected["runtime"] == "node":
            if common is not None:
                previous_signature, previous = common
                if (signature != previous_signature or selected["entry"] != previous[3]
                        or selected["runtime"] != previous[2]):
                    fail("reviewed common Node LSP target data differs")
                prepared[target] = previous
                continue
        runtime = work / ("lsp-runtime-" + str(index))
        canonical = unpack(stage, runtime, version, body["host"]["compatibility"]["min_app_version"],
                           identity=entry["id"], target=target, runtime=selected["runtime"], entry=selected["entry"])
        payload = (runtime, canonical, selected["runtime"], selected["entry"])
        prepared[target] = payload
        if selected["runtime"] == "node":
            common = signature, payload
    if len({payload[2] for payload in prepared.values()}) != 1:
        fail("reviewed LSP package cannot mix native and Node runtimes")
    legacy_node = common is not None and parse_json(common[0][1])["schema_version"] == 1
    return prepared, legacy_node


def pack_lsp(run, work, entry, package, stages, tag, version):
    body = package["package"]
    targets = body["lsp"]["distribution"]["binary"]
    if (not isinstance(targets, dict) or set(targets) != TARGETS or set(stages) != TARGETS
            or body["lsp"]["id"] != entry["id"] or body["lsp"]["version"] != version):
        fail("LSP package identity or targets differ from the reviewed three payload targets")
    payloads, legacy_node = runtime_payload(work, entry, body, stages, targets, version)
    archives = []
    for target in sorted(targets):
        runtime, canonical, runtime_kind, entry_path = payloads[target]
        executable = (runtime / entry_path).read_bytes()
        selected = targets[target]
        name = "lsp-" + entry["id"] + "-" + version + "-" + target + ".tar.gz"
        bound = {"archive": "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + name,
                 "sha256": digest(canonical), "size": len(canonical), "entry": entry_path,
                 "entry_sha256": digest(executable), "entry_size": len(executable), "runtime": runtime_kind}
        reviewed = dict(bound)
        if "node_min_version" in selected:
            minimum = selected["node_min_version"]
            if runtime_kind != "node" or not isinstance(minimum, str) or len(minimum) > 64 or not re.fullmatch(SEMVER, minimum):
                fail("invalid reviewed LSP Node minimum version")
            reviewed["node_min_version"] = minimum
        if "macos_min_version" in selected:
            minimum = selected["macos_min_version"]
            if (runtime_kind != "native" or not target.startswith("darwin-")
                    or not isinstance(minimum, str) or len(minimum) > 64 or not re.fullmatch(SEMVER, minimum)):
                fail("invalid reviewed LSP macOS minimum version")
            reviewed["macos_min_version"] = minimum
        if selected != reviewed:
            fail("reviewed LSP package differs from qualified archive and entry bindings")
        for index in range(2):
            output = work / (name if index == 0 else "repeat-" + name)
            receipt = parse_json(run("registry", "pack-lsp", "--directory", str(runtime),
                "--target", target, "--runtime", runtime_kind, "--entry", entry_path, "--output", str(output)))
            data = output.read_bytes()
            expected = {**bound, "kind": "lsp", "target": target, "archive": str(output)}
            if receipt != expected:
                fail("LSP packaging receipt mismatch")
            if data != canonical:
                fail("Rust LSP archive differs from the reviewed canonical bundle")
        archives.append({"target": target, "name": name, "sha256": bound["sha256"], "size": bound["size"]})
    # Introduce metadata after every target's two canonical archives were captured.
    for runtime in sorted({payload[0] for payload in payloads.values()}):
        (runtime / "lsp.json").write_bytes(json_bytes(package))
    if legacy_node and not any("node_min_version" in target for target in targets.values()):
        # The original shared Node payload remains reconstructible with the pinned
        # 0.15.5 CLI. Every target was already packed twice and byte-bound above.
        run("plugin", "validate", str(next(iter(payloads.values()))[0]), "--kind", "lsp")
        return archives
    for target in sorted(targets):
        runtime = payloads[target][0]
        name = "lsp-" + entry["id"] + "-" + version + "-" + target + ".tar.gz"
        run("plugin", "validate", str(runtime), "--kind", "lsp", "--target", target,
            "--archive", str(work / name))
    return archives
