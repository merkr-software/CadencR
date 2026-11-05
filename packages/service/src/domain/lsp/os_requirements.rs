//! Signed native operating-system requirements share one gate for discovery and launch.
use crate::error::AppError;
use cli_discovery::VersionKey;

pub(super) fn current_macos_version() -> Option<VersionKey> {
    #[cfg(target_os = "macos")]
    {
        static VERSION: std::sync::OnceLock<Option<VersionKey>> = std::sync::OnceLock::new();
        *VERSION.get_or_init(read_macos_version)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn read_macos_version() -> Option<VersionKey> {
    let mut bytes = [0_u8; 128];
    let mut length = bytes.len();
    // Query the operating system directly; PATH and inherited environment cannot override it.
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length == 0 || length > bytes.len() {
        return None;
    }
    let version = std::ffi::CStr::from_bytes_with_nul(&bytes[..length])
        .ok()?
        .to_str()
        .ok()?;
    parse_product_version(version)
}

#[cfg(any(target_os = "macos", test))]
fn parse_product_version(version: &str) -> Option<VersionKey> {
    let parts: Vec<_> = version.split('.').collect();
    if !(2..=3).contains(&parts.len())
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    Some(VersionKey(
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts.get(2).map_or(Some(0), |patch| patch.parse().ok())?,
    ))
}

pub(super) fn satisfies(installed: Option<VersionKey>, minimum: Option<&str>) -> bool {
    let Some(minimum) = minimum else { return true };
    let Ok(required) = semver::Version::parse(minimum) else {
        return false;
    };
    required.pre.is_empty()
        && required.build.is_empty()
        && installed.is_some_and(|version| {
            version >= VersionKey(required.major, required.minor, required.patch)
        })
}

pub(super) fn require_target(target: &cadencr_registry_core::LspTarget) -> Result<(), AppError> {
    let minimum = target.macos_min_version.as_deref();
    if satisfies(current_macos_version(), minimum) {
        return Ok(());
    }
    Err(AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "LSP_MACOS_REQUIRED",
        format!(
            "This language server requires macOS {} or newer. The current operating system does not satisfy this requirement or its version could not be determined.",
            minimum.unwrap_or("a supported version")
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_versions_accept_optional_patch_without_accepting_untrusted_suffixes() {
        assert_eq!(parse_product_version("15.0"), Some(VersionKey(15, 0, 0)));
        assert_eq!(parse_product_version("12.7.6"), Some(VersionKey(12, 7, 6)));
        for value in [
            "15",
            "15.0.0.1",
            "15.0-beta",
            "15.x",
            " 15.0",
            "15..0",
            "15.0\n",
        ] {
            assert_eq!(parse_product_version(value), None, "{value}");
        }
    }

    #[test]
    fn declared_minima_fail_closed_on_old_or_unknown_hosts_without_affecting_legacy_targets() {
        assert!(satisfies(None, None));
        assert!(!satisfies(None, Some("15.0.0")));
        assert!(!satisfies(Some(VersionKey(14, 9, 9)), Some("15.0.0")));
        assert!(satisfies(Some(VersionKey(15, 0, 0)), Some("15.0.0")));
        assert!(satisfies(Some(VersionKey(27, 1, 0)), Some("15.0.0")));
        for value in ["15", "15.0.0-rc.1", "15.0.0+build", "invalid"] {
            assert!(!satisfies(Some(VersionKey(27, 0, 0)), Some(value)));
        }
    }

    #[test]
    fn install_and_launch_gate_reports_the_signed_requirement() {
        let mut target: cadencr_registry_core::LspTarget =
            serde_json::from_value(serde_json::json!({
                "archive":"https://github.com/acme/lsp/releases/download/v1/bundle.tar.gz",
                "sha256":"a".repeat(64), "size":64, "entry":"server",
                "entry_sha256":"b".repeat(64), "entry_size":32, "runtime":"native"
            }))
            .unwrap();
        require_target(&target).unwrap();
        target.macos_min_version = Some("999.0.0".into());
        let error = require_target(&target).unwrap_err();
        assert!(matches!(
            &error,
            AppError::Coded {
                code: "LSP_MACOS_REQUIRED",
                ..
            }
        ));
        assert!(error.to_string().contains("macOS 999.0.0 or newer"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_running_macos_product_version_is_available_without_an_external_command() {
        assert!(current_macos_version().is_some_and(|version| version >= VersionKey(10, 0, 0)));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_hosts_never_claim_a_macos_version() {
        assert_eq!(current_macos_version(), None);
    }
}
