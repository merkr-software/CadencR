# cadencr-tab-backend

Write the native backend of a [Cadencr](https://github.com/merkr-software/CadencR)
custom tab in Rust.

A custom tab may ship a native executable that Cadencr starts per
conversation and talks to over stdin/stdout, one JSON object per line. The
protocol is the contract — [`docs/TAB_BACKEND_PROTOCOL.md`][protocol] — and
any language that produces a native binary can implement it. This crate is
the reference helper: it does the handshake, framing, concurrency and error
handling, so a backend is one function.

[Documentation](https://cadencr.com/docs/tab-backend/) ·
[crates.io](https://crates.io/crates/cadencr-tab-backend) ·
[Rust API reference](https://docs.rs/cadencr-tab-backend)

## Install

Add these dependencies to your native backend project's `Cargo.toml`:

```toml
[dependencies]
cadencr-tab-backend = "0.1"
serde_json = "1"
```

No async runtime is required. Start the web UI with the
[custom tab authoring guide](https://cadencr.com/docs/libraries/#create-your-first-custom-tab)
and use `@cadencr/tab-sdk` to call your backend.

## Quick start

Create `src/main.rs`:

```rust,no_run
use std::process::ExitCode;

use cadencr_tab_backend::{serve, Context, Error};
use serde_json::{json, Value};

fn handle(cx: &Context) -> Result<Value, Error> {
    match cx.method() {
        "greet" => {
            let name: String = cx.params()?;
            Ok(json!(format!("hello, {name}")))
        }
        other => Err(Error::unknown_method(other)),
    }
}

fn main() -> ExitCode {
    serve(handle)
}
```

Build it for every platform the tab supports and point the manifest at the
binaries (paths inside the tab folder):

```json
{
  "backend": {
    "reasoning": "Provides a native greeting service for this tab.",
    "protocol": 1,
    "binary": {
      "darwin-aarch64": "bin/darwin-aarch64/my-backend",
      "darwin-x86_64": "bin/darwin-x86_64/my-backend",
      "linux-x86_64": "bin/linux-x86_64/my-backend"
    }
  }
}
```

Merge this fragment into the tab's existing `tab.json`. Declare only the
platforms you ship. Binaries must be native, executable, and match their
platform; macOS arm64 binaries need a valid signature. Changing the backend
declaration requires renewed user consent.

After connecting with the tab SDK, the web UI calls:

```ts
const greeting = await client.backend.request<string>("greet", "Ada");
// "hello, Ada"
```

Show request errors in your UI. `isReportedByHost(error)` from the tab SDK
identifies startup failures Cadencr already displays with a link to Activity.

## What `serve` does

- reads the `hello` line and refuses (stderr message, exit status 1) a host
  that speaks another protocol version;
- answers `ready`;
- runs requests on a worker pool (8 by default, `serve_with(Config::builder().workers(n).build(), …)`):
  a slow request does not hold up the others, and responses may be written
  out of order;
- turns a handler error into an error response and a panic into an
  `INTERNAL_ERROR` response;
- logs malformed lines to stderr and skips them (a request-shaped line with an
  id but no method is answered with `INVALID_REQUEST`);
- returns `ExitCode::SUCCESS` when stdin closes;
- on Unix, reserves stdin and stdout for the protocol: descriptor 1 is moved
  to a private descriptor and pointed at stderr, so a stray `println!` (yours,
  a dependency's, or a child process's, even one still buffered when `serve`
  starts) ends up in the log instead of breaking the protocol; descriptor 0
  is moved to a private descriptor and pointed at `/dev/null`, so a child
  process you spawn can never read the host's requests. Call `serve` before
  reading stdin yourself.

stderr is the backend's log: Cadencr keeps its last lines and shows them in
the tab's Activity.

## Context and state

| Method                          | Provides                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `method()`, `id()`              | The method and request ID.                                                       |
| `params::<T>()`, `raw_params()` | Decoded or raw JSON params; decoding failures return `INVALID_PARAMS`.           |
| `hello()`                       | Plugin identity, project/feature IDs, worktree, scopes, and API connection info. |
| `state_dir()`                   | Host-provided writable directory for backend state.                              |
| `api()`                         | Scoped blocking HTTP client (requires the `api` feature).                        |

Handlers are `Send + Sync + 'static` and can run concurrently. Store durable
backend state in `state_dir()`, not in the project's worktree or process
memory: the host can stop an idle process. The state directory is shared by
the tab's conversations: coordinate concurrent writes with feature-specific
subdirectories or file locks. Never log the token in `hello()`.
Native backends run with the user's OS rights; Cadencr enforces API scopes
and consent, but does not sandbox their filesystem or network access.

## Features

Both features are off by default; `testing` is always available.

| Feature       | Adds                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api`         | `Context::api()`: a blocking client for the Cadencr API with the backend's own scoped token, decoding Cadencr's `{error, code}` errors. It never uses a proxy (`HTTP_PROXY`/`ALL_PROXY` are ignored) and refuses a `base_url` that is not `http://` to a loopback address, so the token only reaches Cadencr |
| `conformance` | `conformance::run(binary, &Options::default())`: checks any backend binary (in any language) against the protocol, spawned the way the host spawns it (no `CADENCR_*`/`VITE_*` variables, own process group killed at the end); `Options::builder().protocol(n)` for a tab declaring protocol `n`            |

Enable a feature in `Cargo.toml`:

```toml
cadencr-tab-backend = { version = "0.1", features = ["api"] }
```

```rust,no_run
use cadencr_tab_backend::{Context, Error};
use serde_json::Value;

fn git_status(cx: &Context) -> Result<Value, Error> {
    let path = format!("/api/git/status?feature_id={}", cx.hello().feature_id);
    Ok(cx.api()?.get(&path)?)
}
```

This request requires `git:read` in the tab manifest.

## Testing

`testing::TestHost` drives a handler in-process, without spawning a process:

```rust
// Add after the quick-start handler.
#[cfg(test)]
mod tests {
    use super::handle;
    use cadencr_tab_backend::testing::TestHost;
    use serde_json::json;

    #[test]
    fn greets_a_name() {
        let host = TestHost::new(handle);
        assert_eq!(host.call("greet", json!("Ada")), Ok(json!("hello, Ada")));
    }
}
```

With the Cadencr CLI installed, validate the actual tab and current platform's
built binary:

```bash
cadencr plugin validate /absolute/path/to/example-tab --kind tab
```

The CLI runs protocol conformance when the current platform's binary is
present. `--no-run` skips execution, but still checks executable admission.
Test each declared platform with a native build.

See [`examples/echo.rs`](https://github.com/merkr-software/CadencR/blob/main/packages/tab-backend-sdk-rs/examples/echo.rs)
for a complete backend.

## Versioning

The crate is versioned independently of the Cadencr app. It speaks protocol
version 1.

## License

Apache-2.0

[protocol]: https://github.com/merkr-software/CadencR/blob/main/docs/TAB_BACKEND_PROTOCOL.md
