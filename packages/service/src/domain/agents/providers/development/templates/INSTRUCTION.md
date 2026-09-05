# Implement the __DISPLAY_NAME__ provider connector

You are working in the complete source repository for Cadencr provider `__PROVIDER_ID__`. Implement the connector here; do not modify Cadencr itself. You may choose the implementation language, but the final result must be a real executable at `__EXECUTABLE__` and must satisfy every requirement below.

## Required deliverables

- Provider-specific source code that owns native CLI/RPC model discovery and parsing.
- A runtime bridge that speaks ACP v1, either directly or by safely delegating to an existing ACP executable.
- A documented build command that produces `__EXECUTABLE__` on this machine and marks it executable where the OS requires it.
- Automated tests for model parsing, malformed provider output, empty model lists, duplicate model IDs, and the ACP runtime launch path.
- User-facing native CLI prerequisite/configuration notes in `README.md`. The user
  configures and authenticates the provider with its own CLI before using this
  connector. Do not collect, copy, store, broker, or commit credentials or
  generated secrets; Cadencr does not own provider-account authentication.
- A connector-owned `icon.svg` at the repository root. Use the provider's real
  mark when licensing permits it; never add the provider to Cadencr's static
  frontend asset maps or modify the parent Cadencr source tree.
- A passing local validation of all three commands below.

## Executable contract

Cadencr launches the executable directly, never through a shell. Implement exactly these entry points:

| Command                                                       | Required behavior                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `version`                                                     | Print one connector version string to `stdout` and exit `0`.                                       |
| `models --format acp-config-options-v1 --cwd <absolute-path>` | Discover and parse the provider-native models, print one JSON array described below, and exit `0`. |
| `run --protocol acp-v1`                                       | Run an ACP v1 JSON-RPC agent over `stdin`/`stdout` until the session ends.                         |

Additional connector arguments may appear after Cadencr's reserved arguments. Treat them as an argument vector; never interpolate arguments, paths, or credentials into a shell command.

### Process rules

- Reserve `stdout` for the command result or ACP JSON-RPC frames. Send diagnostics to `stderr`.
- `models` must finish within 10 seconds and keep `stdout` below 1 MiB.
- Honor `--cwd` for project-local configuration and model discovery.
- Return a non-zero exit status with an actionable `stderr` message when discovery or startup fails.
- Do not return secrets, tokens, environment values, progress banners, or logs in model JSON.

## Required `models` output

Return a JSON array of ACP v1 `SessionConfigOption` objects. It must contain a non-empty `select` option with `category: "model"`:

```json
[
  {
    "id": "model",
    "name": "Model",
    "description": "Select the model before starting the session",
    "category": "model",
    "type": "select",
    "currentValue": "provider/model-id",
    "options": [
      {
        "value": "provider/model-id",
        "name": "Provider: Model name",
        "description": "Optional model details"
      }
    ]
  }
]
```

The model IDs are opaque provider-owned values. They must be trimmed, non-empty, unique, and exactly match the values accepted by the live ACP session. `currentValue` must name one returned option. Keep the selector `id`; Cadencr uses it to reconcile the user's selection against the live session before the first prompt.

Optional model presentation metadata may be added at `option._meta.cadencr`:

```json
{
  "supportsEffort": true,
  "supportedEffortLevels": ["low", "medium", "high"],
  "defaultEffortLevel": "medium",
  "supportsAdaptiveThinking": false,
  "supportsFastMode": false,
  "supportsAutoMode": false
}
```

Do not invent values. Omit metadata the native provider does not expose.

## ACP v1 runtime requirements

- Complete ACP v1 initialization and `session/new` over stdio.
- Advertise the same live model selector ID and model values returned by `models`.
- Accept `session/set_config_option` for the selected model and return the complete authoritative option snapshot.
- Do not require a speculative `session/prompt` to discover models. Cadencr aborts before the first prompt if live reconciliation fails.
- Preserve ACP streaming, tool calls, permission requests, plan updates, terminal output, cancellation, and errors when the native provider supplies them.
- If the native provider can restore context across process restarts, prefer
  `sessionCapabilities.resume` and implement ACP `session/resume` for the exact
  opaque ID returned by `session/new`. Legacy `agentCapabilities.loadSession`
  plus `session/load` remains a compatibility fallback. Reject a missing, stale,
  workspace-mismatched, or unsupported ID instead of creating fresh context, and
  test the path with two separate connector processes. Do not put either
  capability in the descriptor.
- If the native provider can release an active session cleanly, advertise
  `sessionCapabilities.close` and implement bounded `session/close`. Cadencr will
  still terminate the process after close; do not leave native children running.
- Keep provider-specific flags, aliases, event parsing, and native protocol details inside this repository.

## Local acceptance checklist

Run these from the repository root after building:

```bash
./__EXECUTABLE__ version
./__EXECUTABLE__ models --format acp-config-options-v1 --cwd "$PWD"
```

Then verify the `run` entry point with an ACP v1 client or an automated protocol fixture. Confirm `git status` contains only intentional source/documentation changes; generated binaries under `bin/` are ignored.

Finally, tell the user to restart Cadencr before testing the connector. Cadencr's provider registry is fixed for the process lifetime, so hot reload is intentionally unsupported.

The host descriptor already points `agent.icon` at this repository's
`icon.svg`. Cadencr reads at most 128 KiB, verifies that the resolved file stays
inside this repository, and sends only an inlined image to the renderer. Do not
embed an absolute path, remote tracking URL, or image bytes in connector source.
