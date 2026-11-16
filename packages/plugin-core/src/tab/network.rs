//! `network.allowed_origins`: the only places the egress relay may reach.

use std::collections::BTreeSet;

use super::issues::{TabFindings, TabIssueCode as Code};
use super::manifest::TabNetwork;

pub(crate) const MAX_ALLOWED_ORIGINS: usize = 16;

/// Hosts for which plain `http://` is accepted (with a warning): a local dev server.
const LOOPBACK_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

pub(super) fn validate(network: &TabNetwork, findings: &mut TabFindings) {
    let origins = &network.allowed_origins;
    if origins.len() > MAX_ALLOWED_ORIGINS {
        findings.error(
            Code::OriginsTooMany,
            "network.allowed_origins",
            format!("at most {MAX_ALLOWED_ORIGINS} origins"),
        );
    }
    let mut seen = BTreeSet::new();
    for (index, origin) in origins.iter().enumerate() {
        let field = format!("network.allowed_origins[{index}]");
        match classify(origin) {
            Err(reason) => findings.error(Code::OriginInvalid, field, reason),
            Ok(secure) => {
                if !seen.insert(origin.as_str()) {
                    findings.error(Code::OriginDuplicate, field, "listed twice");
                } else if !secure {
                    findings.warning(
                        Code::OriginInsecureLocalhost,
                        field,
                        "plain http is only for local development; publishable tabs use https",
                    );
                }
            }
        }
    }
    let reasoning = network.reasoning.as_deref().unwrap_or_default().trim();
    if !origins.is_empty() && reasoning.is_empty() {
        findings.error(
            Code::NetworkReasoningRequired,
            "network.reasoning",
            "explain why the tab needs network access; it is shown at consent time",
        );
    }
}

/// `Ok(true)` for an https origin, `Ok(false)` for an accepted loopback http
/// origin, `Err` with the reason otherwise.
///
/// The string must already be in canonical origin form (`scheme://host[:port]`,
/// lowercase, no default port, no trailing slash), which is what the relay
/// compares a request URL's origin against.
fn classify(origin: &str) -> Result<bool, String> {
    if origin.contains('*') {
        return Err("wildcards are not allowed".into());
    }
    let url = url::Url::parse(origin).map_err(|error| format!("not a URL: {error}"))?;
    let secure = match url.scheme() {
        "https" => true,
        "http"
            if url
                .host_str()
                .is_some_and(|host| LOOPBACK_HOSTS.contains(&host)) =>
        {
            false
        }
        "http" => return Err("http is only allowed for localhost or 127.0.0.1".into()),
        _ => return Err("must be an https origin".into()),
    };
    let canonical = url.origin().ascii_serialization();
    if canonical != origin {
        return Err(format!(
            "must be a bare origin without path, query, credentials or default port (did you mean `{canonical}`?)"
        ));
    }
    Ok(secure)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab::test_support::codes;

    fn check(origins: &[&str], reasoning: Option<&str>) -> TabFindings {
        let mut findings = TabFindings::default();
        validate(
            &TabNetwork {
                allowed_origins: origins.iter().map(|origin| origin.to_string()).collect(),
                reasoning: reasoning.map(str::to_string),
            },
            &mut findings,
        );
        findings
    }

    #[test]
    fn https_origins_with_reasoning_are_valid() {
        let findings = check(
            &["https://gitlab.example.com", "https://api.example.com:8443"],
            Some("pipelines"),
        );
        assert!(findings.is_valid(), "{findings:?}");
        assert!(findings.warnings.is_empty());
        assert!(check(&[], None).is_valid());
    }

    #[test]
    fn loopback_http_is_a_warning_not_an_error() {
        let findings = check(
            &["http://localhost:5173", "http://127.0.0.1:8080"],
            Some("dev server"),
        );
        assert!(findings.is_valid(), "{findings:?}");
        assert_eq!(
            codes(&findings.warnings),
            ["ORIGIN_INSECURE_LOCALHOST", "ORIGIN_INSECURE_LOCALHOST"]
        );
    }

    #[test]
    fn non_canonical_and_unsafe_origins_are_errors() {
        for origin in [
            "http://example.com",
            "ftp://example.com",
            "https://example.com/",
            "https://example.com/api",
            "https://example.com?x=1",
            "https://user@example.com",
            "https://example.com:443",
            "https://*.example.com",
            "https://EXAMPLE.com",
            "example.com",
        ] {
            let findings = check(&[origin], Some("r"));
            assert_eq!(codes(&findings.errors), ["ORIGIN_INVALID"], "{origin}");
        }
    }

    #[test]
    fn reasoning_count_and_duplicates() {
        assert_eq!(
            codes(&check(&["https://a.example"], Some("  ")).errors),
            ["NETWORK_REASONING_REQUIRED"]
        );
        assert_eq!(
            codes(&check(&["https://a.example", "https://a.example"], Some("r")).errors),
            ["ORIGIN_DUPLICATE"]
        );
        let many: Vec<String> = (0..17).map(|n| format!("https://h{n}.example")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(codes(&check(&many, Some("r")).errors), ["ORIGINS_TOO_MANY"]);
    }
}
