//! OpenCode's side of Cadencr's browser-tool auto-approval.
//!
//! `opencode acp` starts the servers of its own config (`opencode.json` in the
//! project, the global config) *and* the ones `session/new` passes, even under
//! the same name, and flattens tool names to `<server>_<tool>`. Cadencr's
//! browser trust therefore holds only when OpenCode's resolved config has no
//! server that could answer as `cadencr-browser`.

use opencode_sdk_rs::OpenCodeMcpServerStatus;

use super::resolved_mcp::ResolvedServers;
use crate::domain::mcp::trusted::{normalized_server_name, CadencrBrowserTrust};

/// The tool-name prefix Cadencr reads as its browser server's as is
/// (`canonical_cadencr_tool_name` passes `mcp__cadencr-…` names through).
const CANONICAL_BROWSER_PREFIX: &str = "mcp__cadencr-browser__";

/// `resolved`: OpenCode's resolved config. Only a config that was read and
/// parsed keeps the trust; otherwise the browser tools go through the
/// permission prompt the user sees, which is the safe outcome.
pub(super) fn opencode_browser_trust(
    injected: CadencrBrowserTrust,
    resolved: ResolvedServers,
) -> CadencrBrowserTrust {
    match resolved {
        Ok(configured) => trust_beside(injected, &configured),
        Err(error) => {
            tracing::warn!(
                %error,
                "could not read OpenCode's resolved MCP config; Cadencr browser tools will ask for permission"
            );
            CadencrBrowserTrust::default()
        }
    }
}

/// `configured`: the servers of OpenCode's own config, never the ones
/// Cadencr passes over ACP.
fn trust_beside(
    injected: CadencrBrowserTrust,
    configured: &[OpenCodeMcpServerStatus],
) -> CadencrBrowserTrust {
    let names = || configured.iter().map(|server| server.name.as_str());
    if names().any(flattens_into_canonical_browser_names) {
        return CadencrBrowserTrust::default();
    }
    injected.shadowed_by(names())
}

/// OpenCode names a tool `<server>_<tool>`, so a foreign server whose
/// flattened names can begin with [`CANONICAL_BROWSER_PREFIX`] (`mcp`, `mcp_`,
/// `mcp__cadencr-browser`…) could pass for Cadencr's browser tools.
fn flattens_into_canonical_browser_names(server: &str) -> bool {
    let canonical = normalized_server_name(CANONICAL_BROWSER_PREFIX);
    let flattened = normalized_server_name(&format!("{server}_"));
    canonical.starts_with(&flattened) || flattened.starts_with(&canonical)
}

#[cfg(test)]
mod tests {
    use opencode_sdk_rs::OpenCodeMcpServerStatus;

    use super::{opencode_browser_trust, trust_beside};
    use crate::domain::mcp::trusted::test_support::injected_browser_servers;
    use crate::domain::mcp::trusted::CadencrBrowserTrust;
    use std::sync::Arc;

    fn configured(name: &str) -> OpenCodeMcpServerStatus {
        OpenCodeMcpServerStatus {
            name: name.to_string(),
            status: "connected".to_string(),
        }
    }

    fn injected() -> CadencrBrowserTrust {
        CadencrBrowserTrust::injected_in(Some(&injected_browser_servers()))
    }

    #[test]
    fn project_config_server_named_like_cadencr_browser_revokes_trust() {
        for name in [
            "cadencr-browser",
            "cadencr_browser",
            "cadencr-browser_browser",
        ] {
            assert!(
                !trust_beside(injected(), &[configured(name)]).is_trusted(),
                "{name}"
            );
        }
        assert!(trust_beside(injected(), &[configured("chrome-devtools")]).is_trusted());
    }

    #[test]
    fn a_server_whose_flattened_names_read_as_canonical_revokes_trust() {
        for name in [
            "mcp",
            "mcp_",
            "MCP",
            "mcp__cadencr-browser",
            "mcp__cadencr-browser__x",
        ] {
            assert!(
                !trust_beside(injected(), &[configured(name)]).is_trusted(),
                "{name}"
            );
        }
        assert!(trust_beside(injected(), &[configured("mcp-tools")]).is_trusted());
    }

    #[test]
    fn only_a_config_that_was_read_keeps_the_trust() {
        let read = Ok(Arc::new(vec![configured("chrome-devtools")]));
        assert!(opencode_browser_trust(injected(), read).is_trusted());
        let unreadable = Err("opencode debug config returned invalid JSON".to_string());
        assert!(!opencode_browser_trust(injected(), unreadable).is_trusted());
    }
}
