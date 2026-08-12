# Installed code-backed providers (local substrate)

> - **Status:** Backend/developer substrate implemented; general-purpose desktop installation deliberately withdrawn
> - **Last reviewed:** 2026-08-12
> - **Code:** `packages/service/src/domain/agents/providers/installed/`
> - **Executable contract:** [`PROVIDER_PACKAGE.md`](./PROVIDER_PACKAGE.md)

A provider joins the runtime registry through a descriptor, but the descriptor
is only identity and host launch policy. The referenced executable must contain
provider-specific code implementing Cadencr's mandatory pre-session `models`
command and its live ACP v1 mapping. Pointing Cadencr at an arbitrary ACP
executable is not sufficient.

## Where descriptors live

`<settings-dir>/providers/<agent-id>.json`, which is `~/.cadencr/settings/providers/`
in a packaged build and `<db-dir>/cadencr-settings/providers/` in a dev run.
The directory is scanned **once at startup**, in file-name order.

The file name must equal the agent's `id`. The directory is how a user manages
installs, so a file whose name disagrees with the identity inside it is refused
rather than silently trusted.

Lifecycle writes replace descriptor files atomically with owner-only `0600`
permissions on Unix. This matters because executable arguments and environment
values may contain credentials.

## Descriptor format

```jsonc
{
  // Cadencr host envelope version. Only `1` is understood today.
  "schema_version": 1,

  // Registry-shaped portable agent metadata.
  // https://github.com/agentclientprotocol/registry — agent.schema.json
  "agent": {
    "id": "acme-agent", // ^[a-z][a-z0-9-]*$
    "name": "Acme Agent", // display name; becomes the catalog label
    "version": "1.4.0", // MAJOR.MINOR.PATCH (suffixes allowed)
    "description": "An ACP agent",
    "repository": "https://github.com/acme/agent",
    "website": "https://acme.dev",
    "authors": ["Acme"],
    "license": "MIT",
    "icon": "https://acme.dev/icon.svg",

    // Optional only in Cadencr's hand-written local profile. The strict ACP
    // Registry validation profile requires this field.
    "distribution": {
      "binary": {
        "darwin-aarch64": {
          "archive": "https://github.com/acme/agent/releases/download/v1.4.0/acme-darwin-arm64.tar.gz",
          "sha256": "…64 hex chars…",
          "cmd": "acme",
        },
      },
    },
  },

  // Cadencr host policy. Never part of the portable entry.
  "installation": {
    "enabled": true, // default true
    "executable": {
      "command": "/opt/acme/bin/cadencr-acme-provider", // absolute path, required
      "args": ["--region", "eu"], // appended provider args, never a shell string
      "env": { "ACME_REGION": "eu" }, // literal env for the child
    },
  },
}
```

Fields Cadencr does not model at the top level of `agent` are preserved verbatim.
The host envelope (`schema_version`, `installation`) is Cadencr's own, so an
unknown key there is a typo rather than a newer registry field: it is refused,
not ignored.

### Validation profiles

| Profile                      | `distribution` | Additional policy                                                       |
| ---------------------------- | -------------- | ----------------------------------------------------------------------- |
| Local host descriptor        | Optional       | Rejects ACP-owned capability fields and whitespace-only launch metadata |
| Strict ACP Registry v1 entry | Required       | Mirrors the pinned upstream `agent.schema.json` shape                   |

Both profiles validate every supplied registry field: URI-formatted
`repository`, `website`, and binary `archive`; id and version patterns;
distribution cardinality; platform keys; checksum syntax; and typed, non-null
properties. The upstream root schema permits additional properties, so unknown
root fields round-trip through `AcpAgentEntry::extra`. Its nested distribution
objects set `additionalProperties: false`, so unknown nested fields are rejected
rather than silently dropped.

The vendored upstream snapshots live at
`packages/service/tests/fixtures/acp_registry/v1/`: the v1 schema plus a real
`claude-acp` entry. Tests validate the entry and compare its serialized value to
the original JSON, making schema drift or data loss an explicit source change.

**A descriptor may not declare capabilities.** No models, modes, permission
maps, thought levels, or auth methods. Models come from executable code through
the required `models --format acp-config-options-v1` command; session state and
all other capabilities come from `initialize` and `session/new`. Such a
descriptor field is rejected with `DESCRIPTOR_SCHEMA_VIOLATION`, because a
silently ignored `"models"` key looks honored and is not.

## What this build does and does not do

| Supported                                                                                       | Deferred                                                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Code-backed `models` discovery plus ACP v1 runtime                                              | ACP v2                                                          |
| An explicitly selected local provider-package executable                                       | Downloadable package/archive installation                       |
| Startup loading plus durable add/enable/disable/remove HTTP operations                          | Hot activation / reload                                         |
| Explicit `restart_required` activation semantics                                               | General-purpose desktop provider installation                   |
| Strict descriptor validation and lossless typed round-trip                                      | Registry ingestion/export workflow                              |
| Provider-neutral live select/boolean configuration snapshot plus authenticated WS get/set       | Richer ACP configuration types beyond the v1 baseline           |
| Pre-prompt validation that live ACP still contains and confirms the selected model              | Signed marketplace distribution, assets, and conformance runner |
| Opaque option IDs and authoritative replacement from `session/set_config_option`                | Category-specific placement and built-in-control migration      |

## Requirements on the provider executable

Before ACP starts, the executable must satisfy the command contract in
[`PROVIDER_PACKAGE.md`](./PROVIDER_PACKAGE.md). Cadencr only marks an installed
provider available when `models` returns a verified non-empty model catalog and
a default belonging to that catalog. Discovery failures remain visible as an
unavailable provider; they never fall through to a speculative first prompt.

The runtime baseline from `BOUNDARIES.md` §"Minimum ACP v1 admission contract":
`initialize` at protocol version 1, `session/new`, `session/prompt`,
`session/cancel`, and `session/update`, with standard JSON-RPC errors for
optional methods it does not implement. Optional capabilities widen what the
workspace can offer; they are never an admission requirement. Model discovery
is preflighted on catalog access. Full ACP handshake conformance remains future
package-admission work.
The client advertises ACP v1 boolean configuration support. Options returned by
`session/new` or `session/load` become the live provider-neutral snapshot, and a
successful `session/set_config_option` response replaces that snapshot with its
complete `configOptions` list. Descriptors still cannot declare any of these
values. For code-backed installed providers, the selected pre-session model is
checked against the live ACP selector, applied, and confirmed before
`session/prompt` is allowed.
`packages/service/tests/fixtures/fake_acp_agent.py` provides both a minimal
baseline and a rich deterministic ACP v1 mode. The rich mode exercises commands,
select/boolean configuration, permissions, plans, usage/cost, shell and edit
tools, diffs, and an MCP-shaped tool call. `tests/installed_acp_provider_test.rs`
drives those modes through the runtime registry and the authenticated HTTP +
real WebSocket host surfaces, including interruption of an active turn. Durable
resume and ACP v2 lifecycle remain separate, deferred coverage.

## Descriptor lifecycle API

Authenticated loopback API clients can manage descriptor files without
mutating the running registry. Paired remote clients can read diagnostics but
cannot install an executable or alter host launch policy:

| Operation      | Endpoint                                                    | Durable effect                                    |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| Add            | `POST /api/agents/installed-providers`                      | Validates and atomically writes `<agent.id>.json` |
| Enable/disable | `PUT /api/agents/installed-providers/{provider_id}/enabled` | Atomically changes `installation.enabled`         |
| Remove         | `DELETE /api/agents/installed-providers/{provider_id}`      | Moves the descriptor to the OS trash              |

The registry is immutable for the process lifetime. Responses therefore report
`active_now`, `active_after_restart`, `enabled_after_restart`, and
`restart_required`. The latter is true exactly when current activation differs
from next-boot activation, including a repeated disable of a still-active
provider. Existing sessions and transcripts are untouched; a provider that is
disabled or removed remains active for this process until restart. Its ID also
remains reserved by the running registry, so it cannot be reinstalled with a
different launch configuration before that restart.
The diagnostics route rescans descriptor files, so durable changes are visible
immediately while its `registered` field continues to report the current
process registry.

## Desktop exposure

The free-form **Add local ACP provider** dialog is intentionally not shipped.
Model discovery and native-to-ACP mapping require provider-owned code, while a
simple path/arguments/environment form falsely implies that any ACP executable
is sufficient. The lifecycle API remains a loopback-only developer and future
installer substrate until signed code-and-assets packages exist.

Installed providers still carry `origin: "installed_local"` in the service
catalog. Shared desktop/runtime code may use this provider-neutral origin and
generic session-configuration snapshots; it must never add a `pi` or other
provider-ID branch.

Lifecycle-specific refusal codes use the standard `{ error, code }` envelope:

| Code                         | Meaning                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `PROVIDER_ALREADY_INSTALLED` | The normalized id has a descriptor, belongs to a built-in id/alias, or is still active in this process |
| `PROVIDER_NOT_INSTALLED`     | No valid descriptor exists at that id's path                                       |

Descriptor validation failures reuse the stable rejection codes below.

## When a descriptor is refused or quarantined

`GET /api/agents/installed-providers` lists what a current descriptor scan loads
and refuses, and every startup failure is also logged. Two outcomes,
deliberately distinct:

**Rejected** — never becomes a provider, because its identity or shape could not
be trusted:

| Code                           | Meaning                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `DESCRIPTOR_UNREADABLE`        | The file (or the directory) could not be read              |
| `DESCRIPTOR_INVALID_JSON`      | Not valid JSON                                             |
| `DESCRIPTOR_SCHEMA_VIOLATION`  | JSON, but not a valid host envelope / ACP registry entry   |
| `UNSUPPORTED_SCHEMA_VERSION`   | `schema_version` is from a newer build                     |
| `DESCRIPTOR_IDENTITY_MISMATCH` | File name and `agent.id` disagree                          |
| `DUPLICATE_PROVIDER_ID`        | A built-in id/alias or earlier descriptor owns the normalized public identifier |
| `UNSUPPORTED_DISTRIBUTION`     | No `installation.executable`; this build downloads nothing |
| `INVALID_EXECUTABLE_PATH`      | The command is empty or not absolute                       |

**Quarantined** — a valid install that cannot run right now. It stays registered
and renders as unavailable with the reason attached, instead of disappearing.
`quarantine_code` (with `quarantine_message`) is the single availability signal;
the catalog's `unavailable` status is derived from it:

| Code                        | Meaning                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `INCOMPATIBLE_PLATFORM`     | The declared distribution names no target for this OS/arch |
| `EXECUTABLE_NOT_FOUND`      | The resolved path is not on disk                           |
| `EXECUTABLE_UNREADABLE`     | The path could not be inspected (permissions, bad path)    |
| `EXECUTABLE_NOT_EXECUTABLE` | The path exists but is not an executable file              |

Built-in providers register first, so a descriptor can never take an id or
public alias they own — `claude`, `anthropic`, `codex`, and `openai` are as
reserved as the canonical built-in ids. Reservation uses the same
case/punctuation-insensitive normalization as provider resolution, preventing
variants such as `claudecode` from shadowing `claude-code`. Enablement does not
enter into it: a disabled descriptor still owns its identifier, so a collision
is refused at load time rather than becoming a surprise the day the user
enables it. The resolver also walks built-ins first, providing defense in depth
if a future registration source bypasses descriptor loading.

`executable` is reported without its argument vector. An argument can carry a
credential (`--token …`) and, unlike a fixed set of environment names, there is
no generic way to redact one.

## Security notes

The executable is exec'd directly with its argument vector — deliberately unlike
the built-in ACP adapters, which go through `$SHELL -l -c "exec …"`. Descriptor
data is marketplace data and must never become shell syntax, and the service
already hydrates its own environment from the login shell at startup, so the
child still inherits a terminal-like `PATH`. A relative command is refused
rather than resolved through `PATH`. Environment values are host launch
policy: they are never returned by the API and never logged. On Unix the
descriptor itself is atomically stored with mode `0600`. The process
boundary is **not** an OS sandbox — a local descriptor points at a binary the
user chose, and the marketplace safety work (signing, checksums, blocklist,
sandboxing) in `BOUNDARIES.md` Phase 8 lands before any downloaded agent ships.
