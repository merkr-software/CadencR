//! The host-local installation record.
//!
//! [`HostInstallation`] is what Cadencr owns about an installed ACP provider:
//! the portable registry entry it was installed from, where the descriptor
//! lives, whether the user enabled it, the resolved launch target, and its
//! compatibility state on this machine. The portable entry stays untouched
//! inside it — host policy is never written back into marketplace data.
//!
//! Compatibility is deliberately *not* a capability check. It answers "can this
//! install start on this machine right now?" from identity and distribution
//! data alone. What the agent can actually do is negotiated over ACP after it
//! starts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::assets::ProviderIconAsset;
use super::descriptor::{AcpAgentEntry, LocalExecutableSpec, ProviderDescriptor};
use super::rejection::{DescriptorError, QuarantineCode, RejectionCode};

/// Resolved launch target: an absolute program plus its argument vector.
#[derive(Debug, Clone)]
pub struct LocalExecutable {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl LocalExecutable {
    /// Resolve a descriptor's launch target. A relative command is refused
    /// rather than resolved against `PATH` or the service's working directory:
    /// a descriptor must name exactly one binary, and `PATH` lookup would let
    /// the same file mean different programs at different times.
    pub fn resolve(spec: &LocalExecutableSpec) -> Result<Self, DescriptorError> {
        let command = spec.command.trim();
        if command.is_empty() {
            return Err(DescriptorError::new(
                RejectionCode::InvalidExecutablePath,
                "installation.executable.command must not be empty",
            ));
        }
        let path = PathBuf::from(command);
        if !path.is_absolute() {
            return Err(DescriptorError::new(
                RejectionCode::InvalidExecutablePath,
                format!("installation.executable.command {command:?} must be an absolute path"),
            ));
        }
        Ok(Self {
            command: path,
            args: spec.args.clone(),
            env: spec.env.clone(),
        })
    }
}

/// Why an otherwise valid install cannot run on this machine.
///
/// A quarantined install stays registered and visible; the catalog renders it
/// unavailable with `message` instead of dropping it.
#[derive(Debug, Clone)]
pub struct Quarantine {
    pub code: QuarantineCode,
    pub message: String,
}

/// One installed ACP provider as the host knows it.
#[derive(Debug, Clone)]
pub struct HostInstallation {
    agent: AcpAgentEntry,
    source_path: PathBuf,
    enabled: bool,
    executable: LocalExecutable,
    icon: ProviderIconAsset,
    quarantine: Option<Quarantine>,
}

impl HostInstallation {
    /// Build the host record from a validated descriptor, resolving its launch
    /// target and checking whether that target can run here.
    pub fn from_descriptor(
        descriptor: ProviderDescriptor,
        source_path: &Path,
    ) -> Result<Self, DescriptorError> {
        let spec = descriptor.installation.executable.as_ref().ok_or_else(|| {
            DescriptorError::new(
                RejectionCode::UnsupportedDistribution,
                "this build only launches an explicitly selected local executable; \
                 set installation.executable.command",
            )
        })?;
        let executable = LocalExecutable::resolve(spec)?;
        let quarantine = evaluate_quarantine(&descriptor.agent, &executable);
        let icon = ProviderIconAsset::load(
            descriptor.agent.icon.as_deref(),
            descriptor.installation.assets.as_ref(),
        );
        Ok(Self {
            agent: descriptor.agent,
            source_path: source_path.to_path_buf(),
            enabled: descriptor.installation.enabled,
            executable,
            icon,
            quarantine,
        })
    }

    /// Catalog id. The portable entry owns provider identity; the host never
    /// mints its own.
    pub fn provider_id(&self) -> &str {
        &self.agent.id
    }

    pub fn agent(&self) -> &AcpAgentEntry {
        &self.agent
    }

    pub fn source_path(&self) -> &Path {
        &self.source_path
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// `None` when the install can run.
    pub fn quarantine(&self) -> Option<&Quarantine> {
        self.quarantine.as_ref()
    }

    pub fn executable(&self) -> &LocalExecutable {
        &self.executable
    }

    pub fn icon_data(&self) -> Option<&str> {
        self.icon.data()
    }

    pub fn icon_issue(&self) -> Option<&str> {
        self.icon.issue_message()
    }

    /// The launch target, or a stable error explaining why this install cannot
    /// start. Callers must not spawn a quarantined install.
    pub fn launchable(&self) -> Result<&LocalExecutable, String> {
        match &self.quarantine {
            None => Ok(&self.executable),
            Some(quarantine) => Err(format!(
                "{} is quarantined ({}): {}",
                self.provider_id(),
                quarantine.code.as_str(),
                quarantine.message
            )),
        }
    }
}

/// The declared distribution must cover this platform, and the resolved
/// executable must be a runnable file.
///
/// An explicitly selected local executable does not override a declared
/// platform incompatibility — the portable entry saying "this agent does not
/// run on this OS" is the more trustworthy statement, and quarantine keeps it
/// visible instead of failing at first prompt.
fn evaluate_quarantine(agent: &AcpAgentEntry, executable: &LocalExecutable) -> Option<Quarantine> {
    let quarantine = |code, message| Some(Quarantine { code, message });
    if let Some(distribution) = &agent.distribution {
        if !distribution.supports_current_platform() {
            return quarantine(
                QuarantineCode::IncompatiblePlatform,
                format!(
                    "{} declares no distribution for {}-{}",
                    agent.id,
                    std::env::consts::OS,
                    std::env::consts::ARCH
                ),
            );
        }
    }
    let metadata = match std::fs::metadata(&executable.command) {
        Ok(metadata) => metadata,
        // "missing" and "cannot be inspected" send the user to different fixes,
        // so a denied parent directory must not be reported as a missing file.
        Err(error) => {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => QuarantineCode::ExecutableNotFound,
                _ => QuarantineCode::ExecutableUnreadable,
            };
            return quarantine(code, format!("{}: {error}", executable.command.display()));
        }
    };
    if !metadata.is_file() || !is_executable(&metadata) {
        return quarantine(
            QuarantineCode::ExecutableNotExecutable,
            format!("{} is not an executable file", executable.command.display()),
        );
    }
    None
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::{descriptor, runnable_binary};
    use super::{HostInstallation, QuarantineCode, RejectionCode};
    use serde_json::json;
    use std::path::Path;

    fn agent_json() -> serde_json::Value {
        json!({
            "id": "acme-agent",
            "name": "Acme Agent",
            "version": "1.0.0",
            "description": "d",
        })
    }

    fn build(installation: serde_json::Value) -> Result<HostInstallation, super::DescriptorError> {
        HostInstallation::from_descriptor(
            descriptor(json!({
                "schema_version": 1,
                "agent": agent_json(),
                "installation": installation,
            })),
            Path::new("/p/acme-agent.json"),
        )
    }

    #[test]
    fn a_descriptor_without_a_local_executable_is_an_unsupported_distribution() {
        let error = build(json!({})).expect_err("remote-only installs are not supported yet");
        assert_eq!(error.code, RejectionCode::UnsupportedDistribution);
    }

    #[test]
    fn relative_and_empty_commands_are_refused() {
        for command in ["acme", "./acme", "  "] {
            let error = build(json!({ "executable": { "command": command } }))
                .expect_err("relative command should be refused");
            assert_eq!(
                error.code,
                RejectionCode::InvalidExecutablePath,
                "{command}"
            );
        }
    }

    #[test]
    fn host_record_keeps_identity_on_the_portable_entry() {
        let dir = tempfile::tempdir().unwrap();
        let installation = build(json!({
            "enabled": false,
            "executable": { "command": runnable_binary(dir.path()), "args": ["acp"] },
        }))
        .expect("descriptor should build a host record");

        assert_eq!(installation.provider_id(), "acme-agent");
        assert_eq!(installation.agent().name, "Acme Agent");
        assert!(!installation.enabled());
        assert_eq!(installation.executable().args, vec!["acp".to_string()]);
        assert!(installation.quarantine().is_none());
        assert!(installation.launchable().is_ok());
    }

    #[test]
    fn a_missing_executable_quarantines_instead_of_rejecting() {
        let missing = std::env::temp_dir().join("cadencr-installed-missing-binary");
        let _ = std::fs::remove_file(&missing);
        let installation = build(json!({ "executable": { "command": missing.to_string_lossy() } }))
            .expect("a missing binary is still a valid descriptor");

        assert_eq!(
            installation.quarantine().map(|q| q.code),
            Some(QuarantineCode::ExecutableNotFound)
        );
        let error = installation.launchable().expect_err("must not launch");
        assert!(error.contains("EXECUTABLE_NOT_FOUND"), "{error}");
        assert!(error.contains("acme-agent"), "{error}");
    }

    /// A path Cadencr cannot even inspect gets its own code: telling the user
    /// the binary is missing would send them looking for the wrong problem.
    #[test]
    fn an_uninspectable_path_quarantines_separately_from_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-directory");
        std::fs::write(&blocker, b"regular file").unwrap();
        let installation = build(json!({
            "executable": { "command": blocker.join("acme").to_string_lossy() },
        }))
        .expect("valid descriptor");

        assert_eq!(
            installation.quarantine().map(|q| q.code),
            Some(QuarantineCode::ExecutableUnreadable)
        );
    }

    #[test]
    fn a_non_executable_file_quarantines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acme");
        std::fs::write(&path, b"not a program").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let installation = build(json!({ "executable": { "command": path.to_string_lossy() } }))
            .expect("valid descriptor");

        #[cfg(unix)]
        assert_eq!(
            installation.quarantine().map(|q| q.code),
            Some(QuarantineCode::ExecutableNotExecutable)
        );
        #[cfg(not(unix))]
        assert!(installation.quarantine().is_none());
    }

    /// A local executable does not override an entry that says it has no
    /// distribution for this OS.
    #[test]
    fn a_platform_the_entry_does_not_declare_quarantines() {
        let dir = tempfile::tempdir().unwrap();
        let other = super::super::descriptor::ACP_BINARY_TARGETS
            .iter()
            .find(|target| Some(**target) != super::super::descriptor::current_binary_target())
            .expect("another target");
        let mut agent = agent_json();
        agent["distribution"] =
            json!({ "binary": { (*other): { "archive": "https://x", "cmd": "acme" } } });
        let installation = HostInstallation::from_descriptor(
            descriptor(json!({
                "schema_version": 1,
                "agent": agent,
                "installation": { "executable": { "command": runnable_binary(dir.path()) } },
            })),
            Path::new("/p/acme-agent.json"),
        )
        .expect("valid descriptor");

        assert_eq!(
            installation.quarantine().map(|q| q.code),
            Some(QuarantineCode::IncompatiblePlatform)
        );
    }
}
