use std::path::Path;
use std::sync::{Arc, Once};

use anyhow::{anyhow, Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use sha2::{Digest, Sha256};

/// rustls 0.23 refuses to pick a crypto provider automatically when more than
/// one is linked (e.g. a test pulling aws-lc-rs alongside our `ring`). Install
/// `ring` explicitly, once, so TLS setup is deterministic. Ignoring the result
/// is correct: a prior install by another component is fine — we only need *a*
/// provider present.
fn ensure_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// A ready-to-serve TLS config plus the SHA-256 fingerprint of the leaf cert.
/// The fingerprint is shown in the host UI so the user can verify it against
/// the browser's certificate warning (trust-on-first-use).
pub struct RemoteTls {
    pub config: RustlsConfig,
    pub fingerprint: String,
}

/// Load `cert.pem`/`key.pem` from `dir`, generating a self-signed pair (with the
/// given SANs) on first run. The key is written `0600`. The fingerprint is
/// always recomputed from the cert so it stays a single source of truth.
pub async fn load_or_generate(dir: &Path, sans: Vec<String>) -> Result<RemoteTls> {
    ensure_crypto_provider();
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");

    let (cert_pem, key_pem) = if cert_path.is_file() && key_path.is_file() {
        // Tighten the key's perms on load in case it was restored/copied looser.
        super::secure_fs::ensure_owner_only(&key_path)?;
        (
            std::fs::read_to_string(&cert_path).context("read cert.pem")?,
            std::fs::read_to_string(&key_path).context("read key.pem")?,
        )
    } else {
        let (cert_pem, key_pem) = generate(sans)?;
        write_public(&cert_path, &cert_pem)?;
        super::secure_fs::write_secret(&key_path, key_pem.as_bytes())?;
        (cert_pem, key_pem)
    };

    let fingerprint = fingerprint_from_pem(&cert_pem)?;
    let config = http1_rustls_config(&cert_pem, &key_pem)?;
    Ok(RemoteTls {
        config,
        fingerprint,
    })
}

/// Build the remote listener's rustls config, pinned to **HTTP/1.1**.
///
/// `RustlsConfig::from_pem` advertises `h2` via ALPN, but that breaks the remote
/// listener: the `Host` allowlist (the DNS-rebinding defense) reads the
/// HTTP/1.1 `Host` header, and browsers send `:authority` — not `Host` — over
/// HTTP/2, so every h2 request would be 421'd. WebSocket upgrades
/// (terminal/LSP/agent stream) also require HTTP/1.1. On a single-user LAN
/// listener h2's multiplexing buys little, so we advertise only `http/1.1`.
fn http1_rustls_config(cert_pem: &str, key_pem: &str) -> Result<RustlsConfig> {
    let certs = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| anyhow!("parse certificate PEM: {err}"))?;
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
        .map_err(|err| anyhow!("parse private key PEM: {err}"))?;
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("build rustls server config")?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(RustlsConfig::from_config(Arc::new(config)))
}

fn generate(sans: Vec<String>) -> Result<(String, String)> {
    let certified =
        rcgen::generate_simple_self_signed(sans).context("generate self-signed certificate")?;
    Ok((certified.cert.pem(), certified.signing_key.serialize_pem()))
}

fn write_public(path: &Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents).with_context(|| format!("write {}", path.display()))
}

/// Colon-grouped uppercase SHA-256 of the DER cert — the standard
/// "trust on first use" display form (`AB:CD:EF:...`).
fn fingerprint_from_pem(pem: &str) -> Result<String> {
    let der = first_cert_der(pem)?;
    let digest = Sha256::digest(&der);
    Ok(digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":"))
}

fn first_cert_der(pem: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    let body: String = pem
        .lines()
        .skip_while(|l| !l.starts_with("-----BEGIN CERTIFICATE-----"))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END CERTIFICATE-----"))
        .collect();
    anyhow::ensure!(!body.is_empty(), "no certificate block in PEM");
    base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .context("base64-decode certificate body")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sans() -> Vec<String> {
        vec!["localhost".to_string(), "127.0.0.1".to_string()]
    }

    #[tokio::test]
    async fn generates_then_reloads_with_stable_fingerprint() {
        let dir = tempdir().unwrap();
        let first = load_or_generate(dir.path(), sans()).await.unwrap();
        // 32-byte SHA-256 renders as 32 hex pairs joined by 31 colons.
        assert_eq!(first.fingerprint.matches(':').count(), 31);
        assert!(dir.path().join("cert.pem").is_file());
        assert!(dir.path().join("key.pem").is_file());

        // Second call must reuse the persisted cert (same fingerprint), proving
        // we don't churn the cert on every enable.
        let second = load_or_generate(dir.path(), sans()).await.unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
    }

    #[tokio::test]
    async fn advertises_http1_only() {
        // h2 would 421 every request (browsers send `:authority`, not `Host`, so
        // the remote Host allowlist can't match) and would break WS upgrades.
        let dir = tempdir().unwrap();
        let tls = load_or_generate(dir.path(), sans()).await.unwrap();
        assert_eq!(
            tls.config.get_inner().alpn_protocols,
            vec![b"http/1.1".to_vec()],
            "remote listener must advertise only HTTP/1.1"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn key_is_written_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        load_or_generate(dir.path(), sans()).await.unwrap();
        let mode = std::fs::metadata(dir.path().join("key.pem"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
