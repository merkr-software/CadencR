//! Pins the per-user data roots at startup and records which ones this
//! process resolved, so a log alone tells whether a service writes to the real
//! `~/.cadencr` (XDG dirs on Linux) or to a `--data-dir` (an isolated QA run).

use std::path::Path;

use anyhow::Context;

use crate::shared::app_paths;

/// Pin the roots (`--data-dir` when given) and log the resolved ones once.
pub fn pin_and_log(data_dir: Option<&Path>) -> anyhow::Result<()> {
    app_paths::pin_roots(data_dir)
        .map_err(anyhow::Error::msg)
        .context("could not resolve Cadencr's data directories")?;
    let resolved = |root: Result<std::path::PathBuf, String>| {
        root.map(|path| path.display().to_string())
            .unwrap_or_else(|error| format!("<unresolved: {error}>"))
    };
    tracing::info!(
        "{}",
        describe(
            &resolved(app_paths::data_dir()),
            &resolved(app_paths::config_dir()),
            &resolved(app_paths::cache_dir()),
            data_dir.is_some(),
        )
    );
    Ok(())
}

/// One line: the three roots and whether `--data-dir` chose them.
fn describe(data: &str, config: &str, cache: &str, from_data_dir: bool) -> String {
    let source = if from_data_dir {
        "--data-dir"
    } else {
        "platform default"
    };
    format!("Cadencr data roots ({source}): data={data} config={config} cache={cache}")
}

#[cfg(test)]
mod tests {
    use super::describe;

    #[test]
    fn the_line_names_the_roots_and_their_source() {
        assert_eq!(
            describe("/qa/data", "/qa/data/config", "/qa/data/cache", true),
            "Cadencr data roots (--data-dir): data=/qa/data config=/qa/data/config \
             cache=/qa/data/cache"
        );
        assert!(describe(
            "/u/.cadencr",
            "/u/.cadencr/config",
            "/u/.cadencr/cache",
            false
        )
        .starts_with("Cadencr data roots (platform default): data=/u/.cadencr "));
    }
}
