---
paths:
  - "packages/service/src/**"
  - "packages/desktop/src/**"
  - "packages/*-sdk-rs/src/**"
---

Cadencr is provider-neutral by design — don't scatter provider-specific logic across shared codepaths.

- `packages/*-sdk-rs/` crates carry transport and protocol details only.
- Provider-specific business logic belongs in that provider's backend adapter directory (`packages/service/src/domain/agents/<provider>/`, e.g. `claude_code/`, `codex/`, `opencode/`). `packages/service/src/domain/agents/providers/` holds the shared registry and provider-neutral resolution, not per-provider behavior.
- Shared backend runtime, workflow, and API code consumes the unified adapter interface and provider-neutral types.
- Shared frontend components, hooks, and stores consume provider-neutral catalog/config data — no hardcoded provider branches.
- Built-in providers are registered at runtime through `providers/registry.rs`; shared code resolves adapters via `provider_registry()` / `runtime_adapter()` and must not re-derive a provider list.
- Installed ACP providers (`providers/installed/`) are data, not code: one `GenericAcpAdapter` parameterized by a descriptor. Nothing there may branch on a provider id, and a descriptor may not declare capabilities the ACP handshake owns (models, modes, permission maps, auth) — those come from `initialize` / `session/new`.

When a provider needs special handling, extract it into a dedicated provider file or folder rather than adding another conditional to generic code.

Add built-ins through the ordered `BUILTIN_PROVIDERS` factory table in `packages/service/src/domain/agents/providers/registry.rs`; registration order is user-visible. `provider_registry()` / `runtime_adapter()` return a `ProviderAdapterHandle` (owned, `'static`, dereferencing to the trait).

Local ACP providers need a descriptor, not a code change. `ProviderRegistry::startup()` appends enabled descriptors from `<settings-dir>/providers/*.json`, backed by `GenericAcpAdapter`. That startup scan uses local executables and does not download providers or hot-reload descriptors. Built-ins register first and keep their ids; refusals surface with a stable code at `GET /api/agents/installed-providers`. See `docs/PROVIDER_SPEC/INSTALLED_ACP_PROVIDERS.md` for the descriptor format.
