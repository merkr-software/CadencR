//! A marketplace tab's native backend: the signed `tab.backend` notice and one
//! single-executable archive per platform (`tab.distribution.binary`), kept
//! apart from the platform-neutral web archive.
//!
//! The signed index authenticates every field, so the archive's `sha256` and
//! `size` bound the download and its `executable_sha256` is what the host
//! re-checks before each launch. Native-format recognition is plugin-core's
//! ([`cadencr_plugin_core::tab::check_backend_bytes`]), shared with the
//! service's launch check and `cadencr plugin validate --kind tab`.
use std::collections::BTreeMap;
use std::fmt;

use cadencr_plugin_core::tab::{
    check_backend_bytes, supported_backend_protocols, TabPlatform, SUPPORTED_BACKEND_PROTOCOLS,
};
use serde_json::Value;

use crate::diagnostics::Diagnostics;
use crate::digest::sha256_hex;
use crate::gzip::{gunzip_bounded, GunzipError};
use crate::marketplace::Rules;
use crate::{RegistryError, TabBackendDescriptor, TabBinaryTarget};

mod binding;
mod pack;
mod validate;
pub(crate) use binding::bind;
pub use pack::{pack_tab_backend, PackTabBackendRequest, PackedTabBackend};
pub(crate) use validate::validate_descriptor;

/// Largest backend archive (compressed) a host downloads.
pub const MAX_TAB_BACKEND_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
/// Largest executable a backend archive may hold.
pub const MAX_TAB_BACKEND_EXECUTABLE_BYTES: u64 = 128 * 1024 * 1024;
/// The fields of one `tab.distribution.binary.<platform>` entry, all required.
pub const TAB_BINARY_FIELDS: [&str; 6] = [
    "archive",
    "sha256",
    "size",
    "cmd",
    "executable_sha256",
    "executable_size",
];
/// The executable's mode inside a backend archive.
const EXECUTABLE_MODE: usize = 0o755;
/// One ustar header, padding and the end blocks, plus room for a writer that
/// pads to a full 10 KiB record.
const TAR_OVERHEAD_BYTES: u64 = 512 + 511 + 10 * 1024;
/// Publication-plan targets staging a backend archive are `backend-<platform>`.
const PLAN_TARGET_PREFIX: &str = "backend-";

/// One platform's signed backend archive.
pub type SignedTabBinary = TabBinaryTarget;

/// The validated native backend of a signed tab package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedTabBackend {
    pub protocol: u32,
    pub reasoning: String,
    pub targets: BTreeMap<TabPlatform, SignedTabBinary>,
}

impl SignedTabBackend {
    /// The archive `platform` installs, if the tab ships one for it.
    pub fn target(&self, platform: TabPlatform) -> Option<&SignedTabBinary> {
        self.targets.get(&platform)
    }

    /// The platform Cadencr runs on and its archive, if the tab ships one
    /// for it.
    pub fn host_target(&self) -> Option<(TabPlatform, &SignedTabBinary)> {
        let platform = TabPlatform::current()?;
        Some((platform, self.target(platform)?))
    }
}

/// Why [`signed_tab_backend`] refuses a signed tab package.
#[derive(Debug)]
pub enum TabBackendRefusal {
    /// Its backend speaks a protocol this Cadencr does not; a newer one may
    /// install it.
    UnsupportedProtocol { protocol: u32 },
    /// It ships a backend for a platform key this Cadencr does not know; a
    /// newer one may install it.
    UnknownPlatform { key: String },
    /// Not a valid tab backend.
    Invalid(RegistryError),
}

impl fmt::Display for TabBackendRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TabBackendRefusal::UnsupportedProtocol { protocol } => write!(
                formatter,
                "this tab's backend speaks protocol {protocol}, which this Cadencr does not support ({}); a newer Cadencr may install it",
                supported_backend_protocols()
            ),
            TabBackendRefusal::UnknownPlatform { key } => write!(
                formatter,
                "this tab ships a backend for `{key}`, a platform this Cadencr does not know ({}); a newer Cadencr may install it",
                TabPlatform::list()
            ),
            TabBackendRefusal::Invalid(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for TabBackendRefusal {}

impl From<TabBackendRefusal> for RegistryError {
    fn from(refusal: TabBackendRefusal) -> Self {
        match refusal {
            TabBackendRefusal::Invalid(error) => error,
            other => RegistryError::single(other.to_string()),
        }
    }
}

/// The native backend a tab package (`{kind, package}` entry or its
/// `package` body) declares, validated against the index rules; `None` for a
/// UI-only tab.
///
/// A signed catalog may list a backend this build cannot run — a protocol it
/// does not speak, or a platform key it does not know (see
/// [`validate_catalog_payload_at`](crate::validate_catalog_payload_at)).
/// Such a package is refused here, whole, as
/// [`TabBackendRefusal::UnsupportedProtocol`] or
/// [`TabBackendRefusal::UnknownPlatform`]: it is not installable on this host.
pub fn signed_tab_backend(package: &Value) -> Result<Option<SignedTabBackend>, TabBackendRefusal> {
    let refuse = |message: String| TabBackendRefusal::Invalid(invalid(message));
    let tab = crate::marketplace::body(package)
        .get("tab")
        .and_then(Value::as_object)
        .ok_or_else(|| refuse("signed tab metadata has no tab descriptor".into()))?;
    let mut errors = Diagnostics::default();
    validate_descriptor(tab, "package", Rules::Consume, &mut errors);
    if !errors.is_empty() {
        return Err(TabBackendRefusal::Invalid(RegistryError::from_messages(
            errors.into_messages(),
        )));
    }
    let Some(backend) = tab.get("backend") else {
        return Ok(None);
    };
    let backend: TabBackendDescriptor = serde_json::from_value(backend.clone())
        .map_err(|error| refuse(format!("invalid tab.backend: {error}")))?;
    if !SUPPORTED_BACKEND_PROTOCOLS.contains(&backend.protocol) {
        return Err(TabBackendRefusal::UnsupportedProtocol {
            protocol: backend.protocol,
        });
    }
    let binary: BTreeMap<String, TabBinaryTarget> =
        serde_json::from_value(tab["distribution"]["binary"].clone())
            .map_err(|error| refuse(format!("invalid tab.distribution.binary: {error}")))?;
    let mut targets = BTreeMap::new();
    for (key, target) in binary {
        let Some(platform) = TabPlatform::parse(&key) else {
            return Err(TabBackendRefusal::UnknownPlatform { key });
        };
        targets.insert(platform, target);
    }
    Ok(Some(SignedTabBackend {
        protocol: backend.protocol,
        reasoning: backend.reasoning,
        targets,
    }))
}

/// The publication-plan target that stages `platform`'s backend archive.
pub(crate) fn plan_target(platform: TabPlatform) -> String {
    format!("{PLAN_TARGET_PREFIX}{platform}")
}

/// The platform a [`plan_target`]-style publication target stages, or `None`
/// for any other target.
pub fn plan_target_platform(target: &str) -> Option<TabPlatform> {
    target
        .strip_prefix(PLAN_TARGET_PREFIX)
        .and_then(TabPlatform::parse)
}

/// Verify one downloaded backend archive against its signed entry and return
/// the executable it holds: the archive's exact length and SHA-256, a bounded
/// gzip with no trailing data, a ustar with exactly one regular 0755 file at
/// `cmd` (no directory, link or other entry), the executable's exact length
/// and SHA-256, and a native format for `platform` (signed arm64 code on
/// Apple silicon). Nothing is executed.
pub fn read_tab_backend_archive(
    bytes: &[u8],
    platform: TabPlatform,
    binary: &SignedTabBinary,
) -> Result<Vec<u8>, RegistryError> {
    if bytes.len() as u64 > MAX_TAB_BACKEND_ARCHIVE_BYTES || bytes.len() as u64 != binary.size {
        return Err(invalid(
            "tab backend archive size differs from the signed size",
        ));
    }
    if sha256_hex(bytes) != binary.sha256 {
        return Err(invalid(
            "tab backend archive digest differs from the signed sha256",
        ));
    }
    let limit = binary
        .executable_size
        .min(MAX_TAB_BACKEND_EXECUTABLE_BYTES)
        .saturating_add(TAR_OVERHEAD_BYTES);
    let decoded = gunzip_bounded(bytes, limit).map_err(|error| match error {
        GunzipError::Invalid(error) => invalid(format!("invalid tab backend gzip: {error}")),
        GunzipError::OversizedOrTrailing => {
            invalid("tab backend archive is oversized or has data after its gzip stream")
        }
    })?;
    let mut files = crate::theme_verify::read_tar_with_mode(&decoded, 1, true, EXECUTABLE_MODE)
        .map_err(|_| {
            invalid("tab backend archive must hold exactly one regular 0755 file and nothing else")
        })?;
    let executable = files.remove(&binary.cmd).ok_or_else(|| {
        invalid(format!(
            "tab backend archive must hold its executable at `{}` only",
            binary.cmd
        ))
    })?;
    if executable.len() as u64 != binary.executable_size
        || sha256_hex(&executable) != binary.executable_sha256
    {
        return Err(invalid(
            "tab backend executable differs from the signed executable_sha256/executable_size",
        ));
    }
    check_backend_bytes(&executable, platform)
        .map_err(|problem| invalid(format!("tab backend executable `{}` {problem}", binary.cmd)))?;
    Ok(executable)
}

fn invalid(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::archive::write::header_block;
    use cadencr_plugin_core::tab::test_support::{mach_o, native_executable, MachOSlice};
    use serde_json::json;
    use std::io::Write as _;

    pub(crate) const RELEASE: &str =
        "https://github.com/acme/port-monitor/releases/download/v1.2.0";
    pub(crate) const REASONING: &str = "Lists the TCP ports listening on this machine.";

    pub(crate) fn cmd(platform: &str) -> String {
        format!("bin/{platform}/port-monitor")
    }

    pub(crate) fn target(platform: &str) -> Value {
        json!({"archive":format!("{RELEASE}/tab-backend-{platform}.tar.gz"),"sha256":"b".repeat(64),
            "size":1234,"cmd":cmd(platform),"executable_sha256":"c".repeat(64),"executable_size":4567})
    }

    /// A backend tab entry shipping every platform.
    pub(crate) fn package() -> Value {
        let binary: serde_json::Map<String, Value> = TabPlatform::ALL
            .iter()
            .map(|platform| (platform.to_string(), target(platform.as_str())))
            .collect();
        json!({"kind":"tab","package":{"tab":{"id":"port-monitor","name":"Port monitor",
            "description":"Listening ports","version":"1.2.0","repository":"https://github.com/acme/port-monitor",
            "license":"MIT","api_version":1,"backend":{"protocol":1,"reasoning":REASONING},
            "distribution":{"archive":format!("{RELEASE}/tab.tar.gz"),"sha256":"a".repeat(64),"binary":binary}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"0.13.1"}}}})
    }

    /// The `tab.json` [`package`] is bound to.
    pub(crate) fn manifest_json() -> Value {
        let binary: serde_json::Map<String, Value> = TabPlatform::ALL
            .iter()
            .map(|platform| (platform.to_string(), json!(cmd(platform.as_str()))))
            .collect();
        json!({"schema_version":1,"kind":"tab","id":"port-monitor","name":"Port monitor",
            "version":"1.2.0","api_version":1,"entry":"dist/index.html",
            "backend":{"protocol":1,"reasoning":REASONING,"binary":binary}})
    }

    /// A gzip'd ustar of `(name, mode, type flag, bytes)` entries.
    pub(crate) fn archive(entries: &[(&str, u64, u8, &[u8])]) -> Vec<u8> {
        let mut tar = Vec::new();
        for (name, mode, kind, bytes) in entries {
            tar.extend(header_block(name, *mode, bytes.len() as u64, *kind).unwrap());
            tar.extend(*bytes);
            tar.extend(vec![0; (512 - bytes.len() % 512) % 512]);
        }
        tar.extend([0; 1024]);
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&tar).unwrap();
        gzip.finish().unwrap()
    }

    /// The signed entry describing exactly `bytes`, an archive holding `executable`.
    pub(crate) fn signed(bytes: &[u8], cmd: &str, executable: &[u8]) -> SignedTabBinary {
        SignedTabBinary {
            archive: format!("{RELEASE}/backend.tar.gz"),
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            cmd: cmd.into(),
            executable_sha256: sha256_hex(executable),
            executable_size: executable.len() as u64,
        }
    }

    fn rejected(edit: impl FnOnce(&mut Value)) -> bool {
        let mut value = package();
        edit(&mut value);
        crate::validate_marketplace_package(&value).is_err()
    }

    fn tab(value: &mut Value) -> &mut Value {
        &mut value["package"]["tab"]
    }

    #[test]
    fn a_backend_tab_entry_parses_with_its_signed_targets() {
        let value = package();
        crate::validate_marketplace_package(&value).unwrap();
        let crate::MarketplacePackage::Tab(parsed) =
            crate::parse_marketplace_package(&value).unwrap()
        else {
            panic!("not a tab");
        };
        assert_eq!(parsed.tab.backend.unwrap().protocol, 1);
        assert_eq!(parsed.tab.distribution.binary.unwrap().len(), 3);
        let backend = signed_tab_backend(&value).unwrap().unwrap();
        assert_eq!(backend.reasoning, REASONING);
        let linux = backend.target(TabPlatform::LinuxX86_64).unwrap();
        assert_eq!(linux.cmd, cmd("linux-x86_64"));
        assert_eq!(linux.executable_size, 4567);
        let host = TabPlatform::current().expect("tests run on a supported platform");
        assert_eq!(backend.host_target(), Some((host, &backend.targets[&host])));
        // The body alone resolves the same way; a UI-only tab has none.
        assert_eq!(
            signed_tab_backend(&value["package"]).unwrap(),
            Some(backend)
        );
        let mut ui_only = value;
        tab(&mut ui_only).as_object_mut().unwrap().remove("backend");
        tab(&mut ui_only)["distribution"]
            .as_object_mut()
            .unwrap()
            .remove("binary");
        crate::validate_marketplace_package(&ui_only).unwrap();
        assert_eq!(signed_tab_backend(&ui_only).unwrap(), None);
    }

    #[test]
    fn backend_and_binary_are_declared_together_and_closed() {
        assert!(rejected(|v| {
            tab(v).as_object_mut().unwrap().remove("backend");
        }));
        assert!(rejected(|v| {
            tab(v)["distribution"]
                .as_object_mut()
                .unwrap()
                .remove("binary");
        }));
        assert!(rejected(|v| tab(v)["backend"]["binary"] = json!({})));
        assert!(rejected(|v| tab(v)["backend"]["protocol"] = json!(2)));
        assert!(rejected(|v| tab(v)["backend"]["protocol"] = json!("1")));
        assert!(rejected(|v| tab(v)["backend"]["reasoning"] = json!(" ")));
        assert!(rejected(|v| tab(v)["backend"]["reasoning"] = json!("a\0b")));
        assert!(rejected(
            |v| tab(v)["backend"]["reasoning"] = json!("x".repeat(281))
        ));
        assert!(rejected(|v| tab(v)["distribution"]["binary"] = json!({})));
        assert!(rejected(|v| tab(v)["distribution"]["binary"] = json!([])));
        for root_field in ["cmd", "args", "env", "targets"] {
            assert!(rejected(|v| tab(v)["distribution"][root_field] = json!({})));
        }
        // Theme descriptors stay closed.
        let mut theme = crate::marketplace::tests::theme();
        theme["package"]["theme"]["backend"] = json!({"protocol":1,"reasoning":"r"});
        assert!(crate::validate_marketplace_package(&theme).is_err());
    }

    #[test]
    fn binary_targets_use_tab_platforms_and_exact_fields() {
        fn binary(v: &mut Value) -> &mut Value {
            &mut v["package"]["tab"]["distribution"]["binary"]
        }
        for unknown in ["windows-x86_64", "linux-aarch64", "darwin-universal"] {
            assert!(
                rejected(|v| binary(v)[unknown] = target("linux-x86_64")),
                "{unknown}"
            );
        }
        for field in TAB_BINARY_FIELDS {
            assert!(
                rejected(|v| {
                    binary(v)["linux-x86_64"]
                        .as_object_mut()
                        .unwrap()
                        .remove(field);
                }),
                "{field}"
            );
        }
        assert!(rejected(|v| binary(v)["linux-x86_64"]["args"] = json!([])));
        for (field, value) in [
            ("sha256", json!("B".repeat(64))),
            ("executable_sha256", json!("c".repeat(63))),
            ("size", json!(0)),
            ("size", json!(MAX_TAB_BACKEND_ARCHIVE_BYTES + 1)),
            ("executable_size", json!(0)),
            (
                "executable_size",
                json!(MAX_TAB_BACKEND_EXECUTABLE_BYTES + 1),
            ),
            ("size", json!(-1)),
            ("cmd", json!("tab.json")),
            ("cmd", json!("../escape")),
            ("cmd", json!("/abs/backend")),
            ("cmd", json!("bin\\backend")),
        ] {
            assert!(
                rejected(|v| binary(v)["linux-x86_64"][field] = value.clone()),
                "{field} {value}"
            );
        }
        let mut at_cap = package();
        binary(&mut at_cap)["linux-x86_64"]["size"] = json!(MAX_TAB_BACKEND_ARCHIVE_BYTES);
        binary(&mut at_cap)["linux-x86_64"]["executable_size"] =
            json!(MAX_TAB_BACKEND_EXECUTABLE_BYTES);
        crate::validate_marketplace_package(&at_cap).unwrap();
    }

    #[test]
    fn backend_archives_belong_to_the_web_archive_release() {
        let archive = |v: &mut Value, url: &str| {
            v["package"]["tab"]["distribution"]["binary"]["darwin-aarch64"]["archive"] = json!(url);
        };
        for url in [
            "https://github.com/other/port-monitor/releases/download/v1.2.0/backend.tar.gz",
            "https://github.com/acme/port-monitor/releases/download/v1.1.0/backend.tar.gz",
            "https://github.com/acme/port-monitor/releases/download/v1.2.0/backend.tgz",
            "https://github.com/acme/port-monitor/releases/download/v1.2.0/backend.zip",
            "https://example.com/backend.tar.gz",
            "https://github.com/acme/port-monitor/releases/download/v1.2.0/backend.tar.gz?x=1",
        ] {
            assert!(rejected(|v| archive(v, url)), "{url}");
        }
        assert!(rejected(|v| {
            v["package"]["tab"]["distribution"]["archive"] = json!("not a url");
        }));
    }

    #[test]
    fn a_backend_archive_yields_its_one_native_executable() {
        let elf = native_executable(TabPlatform::LinuxX86_64);
        let name = cmd("linux-x86_64");
        let bytes = archive(&[(&name, 0o755, b'0', &elf)]);
        let entry = signed(&bytes, &name, &elf);
        assert_eq!(
            read_tab_backend_archive(&bytes, TabPlatform::LinuxX86_64, &entry).unwrap(),
            elf
        );
        // Wrong platform, digest, size or path.
        let error =
            read_tab_backend_archive(&bytes, TabPlatform::DarwinX86_64, &entry).unwrap_err();
        assert!(
            error.to_string().contains("not a native executable"),
            "{error}"
        );
        let mut wrong = entry.clone();
        wrong.sha256 = "0".repeat(64);
        assert!(read_tab_backend_archive(&bytes, TabPlatform::LinuxX86_64, &wrong).is_err());
        let mut wrong = entry.clone();
        wrong.size += 1;
        assert!(read_tab_backend_archive(&bytes, TabPlatform::LinuxX86_64, &wrong).is_err());
        let mut wrong = entry.clone();
        wrong.executable_sha256 = "0".repeat(64);
        let error = read_tab_backend_archive(&bytes, TabPlatform::LinuxX86_64, &wrong).unwrap_err();
        assert!(error.to_string().contains("executable_sha256"), "{error}");
        let mut wrong = entry.clone();
        wrong.executable_size -= 1;
        assert!(read_tab_backend_archive(&bytes, TabPlatform::LinuxX86_64, &wrong).is_err());
        let mut wrong = entry;
        wrong.cmd = "bin/other".into();
        assert!(read_tab_backend_archive(&bytes, TabPlatform::LinuxX86_64, &wrong).is_err());
    }

    #[test]
    fn backend_archives_hold_nothing_but_the_executable() {
        let elf = native_executable(TabPlatform::LinuxX86_64);
        let name = cmd("linux-x86_64");
        let refuse = |bytes: Vec<u8>, executable: &[u8]| {
            let entry = signed(&bytes, &name, executable);
            read_tab_backend_archive(&bytes, TabPlatform::LinuxX86_64, &entry).unwrap_err()
        };
        refuse(
            archive(&[(&name, 0o755, b'0', &elf), ("README", 0o755, b'0', b"x")]),
            &elf,
        );
        refuse(
            archive(&[("bin/", 0o755, b'5', b""), (&name, 0o755, b'0', &elf)]),
            &elf,
        );
        refuse(archive(&[(&name, 0o644, b'0', &elf)]), &elf);
        refuse(archive(&[(&name, 0o755, b'2', b"")]), b"");
        refuse(archive(&[(&name, 0o755, b'1', b"")]), b"");
        refuse(
            archive(&[(&name, 0o755, b'0', b"#!/bin/sh\necho hi\n")]),
            b"#!/bin/sh\necho hi\n",
        );
        // Data after the gzip stream, even another valid member.
        let mut trailing = archive(&[(&name, 0o755, b'0', &elf)]);
        trailing.extend(archive(&[]));
        let error = refuse(trailing, &elf);
        assert!(
            error.to_string().contains("after its gzip stream"),
            "{error}"
        );
        let unsigned = mach_o(&[MachOSlice::Arm64Unsigned]);
        let bytes = archive(&[(&name, 0o755, b'0', &unsigned)]);
        let entry = signed(&bytes, &name, &unsigned);
        let error =
            read_tab_backend_archive(&bytes, TabPlatform::DarwinAarch64, &entry).unwrap_err();
        assert!(error.to_string().contains("unsigned arm64"), "{error}");
    }
}
