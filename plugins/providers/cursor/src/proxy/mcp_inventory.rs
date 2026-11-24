//! Cursor's native list includes project, user and team servers. If the CLI
//! cannot enumerate them, leave the MCP approval to the user.
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::watch;

use super::child::Launch;

pub(super) type Inventory = watch::Receiver<Option<HashSet<String>>>;

/// Discovery starts alongside session setup. Only an eligible permission waits for the result.
pub(super) fn start(launch: &Launch, params: &Value) -> Option<Inventory> {
    let cwd = Path::new(params["cwd"].as_str()?);
    let attached = params["mcpServers"].as_array()?.iter().any(|server| {
        matches!(
            server["name"].as_str(),
            Some("cadencr-browser" | "cadencr-project" | "cadencr-workspace")
        )
    });
    if !attached || !launch.extra_args.is_empty() || !cwd.is_absolute() {
        return None;
    }
    let binary = launch.binary.clone();
    let cwd = cwd.to_owned();
    let (tx, rx) = watch::channel(None);
    tokio::spawn(async move {
        tokio::select! {
            () = tx.closed() => {},
            result = native_servers(&binary, &cwd) => { tx.send_replace(result); }
        }
    });
    Some(rx)
}

async fn native_servers(binary: &Path, cwd: &Path) -> Option<HashSet<String>> {
    match crate::cli::run_captured(
        binary,
        &["mcp".into(), "list".into()],
        Some(cwd),
        Duration::from_secs(15),
    )
    .await
    {
        Ok(out) if out.status.success() => parse(std::str::from_utf8(&out.stdout).ok()?),
        _ => {
            eprintln!("Cursor MCP inventory unavailable; using native permission prompts");
            None
        }
    }
}

fn parse(stdout: &str) -> Option<HashSet<String>> {
    if stdout.trim()
        == "No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)"
    {
        return Some(HashSet::new());
    }
    let mut names = HashSet::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let (name, status) = line.split_once(": ")?;
        let recognized = [
            "ready",
            "requires_authentication",
            "loading",
            "disabled",
            "not loaded (needs approval)",
        ]
        .iter()
        .any(|known| {
            status == *known
                || status
                    .strip_prefix(known)
                    .is_some_and(|suffix| suffix.starts_with(" (") && suffix.ends_with(')'))
        }) || status.starts_with("Error: ");
        if !recognized
            || name.is_empty()
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        {
            return None;
        }
        names.insert(name.to_owned());
    }
    (!names.is_empty()).then_some(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_complete_native_listing() {
        assert_eq!(
            parse("No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)"),
            Some(HashSet::new())
        );
        assert_eq!(
            parse("cadencr-project: not loaded (needs approval)\ntest-a: Error: Connection failed"),
            Some(HashSet::from(["cadencr-project".into(), "test-a".into()]))
        );
        for unrecognized in [
            "",
            "partial response",
            "warning: native error",
            "server: ready\nextra",
        ] {
            assert!(parse(unrecognized).is_none());
        }
    }
}
