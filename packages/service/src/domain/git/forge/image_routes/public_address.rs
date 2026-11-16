use std::net::IpAddr;

use reqwest::Url;

use crate::error::AppError;
use crate::shared::http_relay::is_public_ip;

/// Refuse a URL before it becomes a request.
///
/// The service is a local process and pull-request bodies are attacker-controlled,
/// so an unrestricted image fetch could probe the user's own network.
pub fn ensure_fetchable(url: &Url) -> Result<(), AppError> {
    if url.scheme() != "https" {
        return Err(AppError::BadRequest(
            "Only HTTPS images are loaded, so the request cannot be read in transit".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::BadRequest(
            "An image URL cannot carry credentials".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::BadRequest("Image URL is missing a host".into()))?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let reachable = match bare.parse::<IpAddr>() {
        Ok(address) => is_public_ip(address),
        Err(_) => is_public_domain(bare),
    };
    if !reachable {
        return Err(AppError::BadRequest(format!(
            "Images are only loaded from public hosts, and {host} is not one"
        )));
    }
    Ok(())
}

fn is_public_domain(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host.contains('.')
        && !["localhost", "local", "internal", "home", "lan", "intranet"]
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_https_hosts_are_fetched() {
        for allowed in [
            "https://github.com/a.png",
            "https://8.8.8.8/a.png",
            "https://[2606:4700::1]/a.png",
        ] {
            ensure_fetchable(&Url::parse(allowed).unwrap()).expect(allowed);
        }
        for refused in [
            "http://github.com/a.png",
            "https://user:pass@github.com/a.png",
            "https://127.0.0.1/a.png",
            "https://10.0.0.5/a.png",
            "https://192.168.1.20/a.png",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/a.png",
            "https://[fd00::1]/a.png",
            "https://localhost/a.png",
            "https://printer.local/a.png",
            "https://intranet/a.png",
        ] {
            assert!(
                ensure_fetchable(&Url::parse(refused).unwrap()).is_err(),
                "{refused}"
            );
        }
    }
}
