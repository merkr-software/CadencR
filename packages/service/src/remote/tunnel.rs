use std::net::IpAddr;

use crate::remote::REMOTE_TUNNEL_HOST_SETTING;

/// Exact `Host` values accepted on the remote listener: loopback and each LAN
/// IP on the remote port, plus the configured tunnel host (no port — tunnels
/// terminate TLS on the standard 443). Never a wildcard — this is the
/// DNS-rebinding guard.
pub(super) fn allowed_hosts(
    lan_ips: &[IpAddr],
    port: u16,
    tunnel_host: Option<&str>,
) -> Vec<String> {
    let mut hosts = vec![format!("localhost:{port}"), format!("127.0.0.1:{port}")];
    hosts.extend(lan_ips.iter().map(|ip| format!("{ip}:{port}")));
    if let Some(host) = tunnel_host {
        hosts.push(host.to_string());
    }
    hosts
}

/// `https://<host>` form of [`allowed_hosts`] for WebSocket origin checks.
pub(super) fn allowed_origins(
    lan_ips: &[IpAddr],
    port: u16,
    tunnel_host: Option<&str>,
) -> Vec<String> {
    allowed_hosts(lan_ips, port, tunnel_host)
        .into_iter()
        .map(|host| format!("https://{host}"))
        .collect()
}

/// Read + normalize the persisted tunnel host. `None` when unset/blank or on a
/// read error (degrade gracefully — a missing tunnel host just means LAN-only).
/// Shared by the listener (allowlist) and the HTTP layer (status + pairing URLs)
/// so normalization lives in one place.
pub async fn load_tunnel_host(pool: &sqlx::SqlitePool) -> Option<String> {
    let raw = crate::domain::workspace::repository::get_setting(pool, REMOTE_TUNNEL_HOST_SETTING)
        .await
        .ok()
        .flatten()?;
    sanitize_tunnel_host(&raw)
}

/// Reduce user input to a bare `Host` value: strip scheme, path, and any
/// trailing slash; lowercase. Returns `None` for blank input. Keeps an explicit
/// `:port` if the user typed one (some tunnels expose a non-443 port).
pub fn sanitize_tunnel_host(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(without_scheme)
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if is_valid_tunnel_host(&host) {
        Some(host)
    } else {
        None
    }
}

fn is_valid_tunnel_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    if host
        .bytes()
        .any(|b| b.is_ascii_whitespace() || matches!(b, b'@' | b'\\' | b'%'))
    {
        return false;
    }

    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => {
            if name.contains(':') || port.is_empty() {
                return false;
            }
            let Ok(port) = port.parse::<u16>() else {
                return false;
            };
            (name, Some(port))
        }
        None => (host, None),
    };
    if matches!(port, Some(0)) {
        return false;
    }
    is_valid_dns_host(name)
}

fn is_valid_dns_host(name: &str) -> bool {
    if name.is_empty() || name == "localhost" || name.starts_with('.') || name.ends_with('.') {
        return false;
    }
    name.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_scheme_path_and_case() {
        assert_eq!(
            sanitize_tunnel_host("https://Foo.ngrok.app/connect?x=1"),
            Some("foo.ngrok.app".to_string())
        );
        assert_eq!(
            sanitize_tunnel_host("  laptop.tail1234.ts.net  "),
            Some("laptop.tail1234.ts.net".to_string())
        );
        assert_eq!(
            sanitize_tunnel_host("host:8443/"),
            Some("host:8443".to_string())
        );
    }

    #[test]
    fn sanitize_rejects_blank() {
        assert_eq!(sanitize_tunnel_host(""), None);
        assert_eq!(sanitize_tunnel_host("   "), None);
        assert_eq!(sanitize_tunnel_host("https://"), None);
    }

    #[test]
    fn sanitize_rejects_misleading_or_invalid_authorities() {
        assert_eq!(
            sanitize_tunnel_host("https://trusted.ts.net@evil.example"),
            None,
            "userinfo-style hosts would make the browser connect to the wrong origin"
        );
        assert_eq!(sanitize_tunnel_host("host name.ts.net"), None);
        assert_eq!(sanitize_tunnel_host("host\\name.ts.net"), None);
        assert_eq!(sanitize_tunnel_host("host.ts.net:99999"), None);
    }

    #[test]
    fn sanitize_accepts_valid_host_with_optional_port() {
        assert_eq!(
            sanitize_tunnel_host("Laptop.Tail1234.ts.net:8443/"),
            Some("laptop.tail1234.ts.net:8443".to_string())
        );
    }

    #[test]
    fn dns_host_validation_is_conservative() {
        assert!(is_valid_dns_host("laptop.tail1234.ts.net"));
        assert!(!is_valid_dns_host("localhost"));
        assert!(!is_valid_dns_host("-bad.example"));
        assert!(!is_valid_dns_host("bad-.example"));
        assert!(!is_valid_dns_host("bad..example"));
    }

    #[test]
    fn tunnel_host_validation_handles_optional_ports() {
        assert!(is_valid_tunnel_host("laptop.tail1234.ts.net:8443"));
        assert!(!is_valid_tunnel_host("laptop.tail1234.ts.net:0"));
        assert!(!is_valid_tunnel_host("laptop.tail1234.ts.net:99999"));
        assert!(!is_valid_tunnel_host("laptop.tail1234.ts.net:port"));
    }

    #[test]
    fn tunnel_host_extends_allowlist_without_port() {
        let hosts = allowed_hosts(&[], 5006, Some("foo.ngrok.app"));
        assert!(hosts.contains(&"foo.ngrok.app".to_string()));
        assert!(hosts.contains(&"127.0.0.1:5006".to_string()));
        let origins = allowed_origins(&[], 5006, Some("foo.ngrok.app"));
        assert!(origins.contains(&"https://foo.ngrok.app".to_string()));
    }

    #[test]
    fn no_tunnel_host_leaves_allowlist_lan_only() {
        let hosts = allowed_hosts(&[], 5006, None);
        assert!(hosts.iter().all(|h| h.ends_with(":5006")));
    }
}
