//! Emits the OpenAPI 3 spec for the cadencr service to disk.
//!
//! Used by `pnpm --filter @cadencr/desktop generate:api` to feed orval. The
//! output file is intentionally gitignored — the source of truth is the Rust
//! `utoipa` annotations, and the generated TypeScript client is what gets
//! committed.
//!
//! `dump-openapi --plugin-surface <out>` writes the custom-tab plugin surface
//! instead (the policy table's operations only), which
//! `pnpm --filter @cadencr/tab-sdk generate:api` feeds to orval.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

const PLUGIN_SURFACE_FLAG: &str = "--plugin-surface";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let plugin_surface = args.iter().any(|arg| arg == PLUGIN_SURFACE_FLAG);
    let spec = cadencr_service::api::openapi::api_doc();
    let json = if plugin_surface {
        cadencr_service::domain::plugin_tabs::surface::plugin_surface(&spec)
            .and_then(|surface| serde_json::to_string_pretty(&surface).map_err(|e| e.to_string()))
    } else {
        serde_json::to_string_pretty(&spec).map_err(|e| e.to_string())
    };
    let json = match json {
        Ok(s) => s,
        Err(err) => {
            eprintln!("dump-openapi: failed to serialize spec: {err}");
            return ExitCode::FAILURE;
        }
    };

    let out_path = resolve_output_path(&args);

    let mut payload = json;
    payload.push('\n');
    if let Err(err) = fs::write(&out_path, payload) {
        eprintln!(
            "dump-openapi: failed to write {}: {err}",
            out_path.display()
        );
        return ExitCode::FAILURE;
    }

    println!("dump-openapi: wrote {}", out_path.display());
    ExitCode::SUCCESS
}

/// Default to `<crate>/openapi.json`. The first positional argument overrides.
fn resolve_output_path(args: &[String]) -> PathBuf {
    if let Some(arg) = args.iter().find(|arg| arg.as_str() != PLUGIN_SURFACE_FLAG) {
        return PathBuf::from(arg);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("openapi.json")
}
