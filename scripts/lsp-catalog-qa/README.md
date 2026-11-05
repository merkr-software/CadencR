# Held LSP catalog qualification

This harness produces candidate evidence for 24 reviewed Node/native recipes and
an unchanged published TypeScript baseline. It has no signing, author, release,
registry or production-feed authority. Packaging success never establishes runtime
or application qualification.

## Workflow and provenance

`.github/workflows/lsp-catalog-qualification.yml` runs for relevant pull requests
and explicit manual dispatches. Its only repository permission is `contents: read`;
checkout never persists credentials.

| Stage | Host | What it establishes |
| --- | --- | --- |
| Canonical preparation | Ubuntu 24.04 | Reviewed acquisition, committed overlays, exact CLI receipts and two byte-identical packs per target |
| Runtime baseline | Ubuntu 22.04, x86_64 | Real features using the exact handed-off Linux archive |
| Runtime current | Ubuntu 24.04, x86_64 | Real features using that same Linux archive |
| Runtime Apple Silicon | macOS 15, ARM64 | Real features using the handed-off ARM archive |
| Runtime Intel | macOS 15, x86_64 | Real features using the handed-off Intel archive |

Canonical preparation uses Ubuntu 24.04 because the reviewed Clangd transform
requires GNU `strip` 2.42. Runtime jobs do not execute the packaging CLI. A CLI
built on Ubuntu 24.04 therefore makes no claim about CLI support on Ubuntu 22.04.
The macOS jobs establish behavior on their actual macOS 15 hosts, not a minimum
supported macOS version. Runner labels follow the [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Pull requests and the default manual mode build CLI `0.15.6` from the checked-out
source with `pnpm rust -- build --locked --release -p cadencr-cli`. Evidence labels
this `source-build` and records its source commit and SHA-256. It is **not**
qualification of a publicly distributed CLI binary.

Manual `cli_mode: released` fetches only `scripts/cli-qualification.env`, and fails
unless that checked-in pin names `cli/v0.15.6`, the exact binary checksum and the
expected version. Its evidence says `released-pin` and records the pin-file digest.
Updating or promoting that pin remains a separate reviewed release operation.

## Artifact and runtime boundaries

- Preparation requires a clean committed source snapshot. Node adapters and license
  notices are copied from that exact commit by `node_overlay.py`; no candidate npm
  lifecycle, adapter or language server runs during preparation.
- The handoff contains only archive, source-lock, recipe and package metadata files,
  plus preparation and hash manifests. Full paths, sizes and raw SHA-256 values form
  a closed inventory. The TypeScript baseline must retain published archive digest
  `295472a5ede14af100e3a0fb0eb121d71d2818ee05399ffb3dac3290b0ec7286`.
- Runtime jobs download the **exact upload artifact ID from their package job**, then
  check the independent job-output hash of `handoff.json`, source commit, CLI
  provenance and every file. They do not discover artifacts by a mutable name,
  another run or an external URL.
- Frozen ESLint/Tailwind test projects and the officially pinned Go toolchain are
  acquired before runtime. Node is exactly `22.19.0`. Runtime performs no npm,
  dependency, toolchain or network acquisition.
- Linux creates mount and network namespaces, mounts checkout, handoff, prerequisites
  and Node read-only, then uses `setpriv` to drop all capabilities and set
  `no_new_privs` before an `env -i` Python process starts. The runner verifies those
  conditions and loopback-only interfaces before starting a payload.
- macOS first tests a Seatbelt profile that denies IP networking and protected file
  writes while permitting local Unix-domain IPC. Both semantic runners use that
  same policy for payloads, descendants and cleanup. Unix IPC is needed by Biome.
- Source locks are checked before extraction, and extracted files retain reviewed
  hashes/modes. The exact archive and extracted inventory are checked again after
  the semantic feature. A successful initialize handshake alone cannot pass.

`node_smoke.py` exercises real diagnostics, hover, completion or document symbols
with no implicit host settings. `native_semantic.py` exercises corresponding native
features. Vue additionally checks its packaged bridge, hover and live-edit diagnostic
clearing. GraphQL and Astro run on both Linux baselines, including their bundled
runtime dependencies. These probes complement application/proxy QA; they do not
replace it.

## Local commands

Run the key-free boundary tests on either supported host:

```sh
python3 -B -m unittest discover -s scripts/lsp-catalog-qa -p 'test_*.py'
```

Prepare from a committed source snapshot on Linux x86_64, using new absolute output
and work directories:

```sh
python3 -B scripts/lsp-catalog-qa/prepare.py \
  --source-commit "$SOURCE_COMMIT" --cli /absolute/path/to/cadencr \
  --cli-sha256 "$CLI_SHA256" --cli-origin source-build \
  --work /tmp/lsp-preparation-work --output /tmp/lsp-handoff
```

For a data-only dry run, validate and unpack a handoff without launching any payload:

```sh
python3 -B scripts/lsp-catalog-qa/runtime.py \
  --handoff /tmp/lsp-handoff --manifest-sha256 "$HANDOFF_SHA256" \
  --source-commit "$SOURCE_COMMIT" --target darwin-aarch64 --verify-only \
  --work /tmp/lsp-data-work --evidence /tmp/lsp-data-evidence \
  --diagnostics /tmp/lsp-data-diagnostics
```

This writes `status: data-verified` and leaves `runtime_qualification: PENDING`.
It cannot be presented as a native runtime pass.

For real runtime, first call `prerequisites.py` with `--node`, `--source-commit`,
`--cache` and `--output`; pass its manifest SHA-256 to `runtime.py`. Use the workflow's
Linux namespace launcher or native macOS invocation. An ordinary Linux shell is
intentionally rejected. Every work/evidence/diagnostic directory must be new.

## Evidence and failures

| Output | Contents |
| --- | --- |
| Candidate handoff | Closed held data and `runtime_qualification: PENDING` |
| `evidence/runtime.json` | Actual host, source/CLI/artifact bindings and per-server feature verdicts |
| Separate diagnostic artifact | Bounded semantic reports, server stderr and preparation/runtime failures |

A runtime pass applies only to the recorded host and target. The four hosted jobs
must complete before claiming matrix qualification. `publication_authority` remains
`false` in every output, including successful ones.
