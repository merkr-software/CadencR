//! Direct command preparation shared by model discovery and ACP runtime spawn.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::Path;

use crate::domain::agents::acp::AcpProcessTreePolicy;

use super::installation::LocalExecutable;
use super::managed::installer::{
    is_managed_executable_in, verify_managed_launch_in, ManagedStorage,
};
use super::managed::process_policy::{managed_command, managed_process_tree_policy};

#[derive(Debug)]
pub(super) struct PreparedProviderCommand {
    pub command: tokio::process::Command,
    pub process_tree_policy: AcpProcessTreePolicy,
}

#[derive(Debug, Clone)]
pub(super) struct ProviderCommandError(String);

impl ProviderCommandError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for ProviderCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProviderCommandError {}

/// Prepare one direct provider command. Managed-package filesystem and receipt
/// verification runs off the async worker before the command is constructed.
pub(super) async fn prepare_provider_command(
    executable: &LocalExecutable,
    reserved_args: &[OsString],
    cwd: &Path,
    caller_env: Option<&HashMap<String, String>>,
) -> Result<PreparedProviderCommand, ProviderCommandError> {
    // Capture this on the caller thread: test settings directories are
    // thread-local and would otherwise be lost inside spawn_blocking.
    let storage = ManagedStorage::production();
    let command_path = executable.command.clone();
    let is_managed = is_managed_executable_in(&storage, &command_path);
    if is_managed {
        tokio::task::spawn_blocking(move || verify_managed_launch_in(&storage, &command_path))
            .await
            .map_err(|error| {
                ProviderCommandError::new(format!(
                    "managed provider launch verification task failed: {error}"
                ))
            })?
            .map_err(|error| {
                ProviderCommandError::new(format!("managed provider launch rejected: {error}"))
            })?;
    }
    prepare_provider_command_with_classification(
        executable,
        reserved_args,
        cwd,
        caller_env,
        is_managed,
    )
}

fn prepare_provider_command_with_classification(
    executable: &LocalExecutable,
    reserved_args: &[OsString],
    cwd: &Path,
    caller_env: Option<&HashMap<String, String>>,
    is_managed: bool,
) -> Result<PreparedProviderCommand, ProviderCommandError> {
    let args = reserved_args
        .iter()
        .cloned()
        .chain(executable.args.iter().map(OsString::from))
        .collect::<Vec<_>>();
    let mut environment = executable.env.clone();
    merge_caller_environment(&mut environment, caller_env);

    let (mut command, process_tree_policy) = if is_managed {
        let command = managed_command(&executable.command, &[], &environment, cwd)
            .map_err(|error| ProviderCommandError::new(error.to_string()))?;
        (command, managed_process_tree_policy())
    } else {
        let mut command = tokio::process::Command::new(&executable.command);
        command.current_dir(cwd);
        for (key, value) in environment {
            command.env(key, value);
        }
        (command, AcpProcessTreePolicy::Inherit)
    };
    command.args(args);
    Ok(PreparedProviderCommand {
        command,
        process_tree_policy,
    })
}

fn merge_caller_environment(
    environment: &mut BTreeMap<String, String>,
    caller_env: Option<&HashMap<String, String>>,
) {
    if let Some(caller_env) = caller_env {
        for (key, value) in caller_env {
            environment.insert(key.clone(), value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::PathBuf;

    fn executable(directory: &tempfile::TempDir) -> LocalExecutable {
        let command = directory.path().join("agent");
        std::fs::write(&command, b"agent").unwrap();
        LocalExecutable {
            command,
            args: vec!["--provider-arg".into()],
            env: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn local_descriptors_keep_explicit_environment_and_inherit_processes() {
        let directory = tempfile::tempdir().unwrap();
        let mut executable = executable(&directory);
        executable
            .env
            .insert("ACME_AGENT_COMMAND".into(), "/custom/agent".into());
        let prepared = prepare_provider_command(
            &executable,
            &[OsString::from("run"), OsString::from("--protocol")],
            directory.path(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(prepared.process_tree_policy, AcpProcessTreePolicy::Inherit);
        assert_eq!(
            prepared
                .command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == "ACME_AGENT_COMMAND")
                .and_then(|(_, value)| value),
            Some(OsStr::new("/custom/agent"))
        );
        assert_eq!(
            prepared.command.as_std().get_args().collect::<Vec<_>>(),
            ["run", "--protocol", "--provider-arg"]
                .map(OsStr::new)
                .as_slice()
        );
    }

    #[test]
    fn managed_classification_uses_strict_environment_and_isolated_processes() {
        let directory = tempfile::tempdir().unwrap();
        let mut executable = executable(&directory);
        executable
            .env
            .insert("OPENAI_API_KEY".into(), "descriptor".into());
        let caller_env = HashMap::from([("OPENAI_API_KEY".into(), "caller".into())]);
        let prepared = prepare_provider_command_with_classification(
            &executable,
            &[OsString::from("run")],
            directory.path(),
            Some(&caller_env),
            true,
        )
        .unwrap();

        assert!(matches!(
            prepared.process_tree_policy,
            AcpProcessTreePolicy::Isolated(_)
        ));
        assert_eq!(
            prepared
                .command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == "OPENAI_API_KEY")
                .and_then(|(_, value)| value),
            Some(OsStr::new("caller"))
        );
    }

    #[test]
    fn managed_classification_rejects_host_environment_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let executable = executable(&directory);
        let caller_env = HashMap::from([("VITE_API_TOKEN".into(), "secret".into())]);
        let error = prepare_provider_command_with_classification(
            &executable,
            &[OsString::from("models")],
            directory.path(),
            Some(&caller_env),
            true,
        )
        .expect_err("managed policy must reject the host namespace");
        assert!(error.to_string().contains("VITE_API_TOKEN"));
    }

    #[test]
    fn managed_policy_failure_short_circuits_command_preparation() {
        let directory = tempfile::tempdir().unwrap();
        let executable = executable(&directory);
        let missing_cwd = PathBuf::from("missing-relative-cwd");
        let error = prepare_provider_command_with_classification(
            &executable,
            &[OsString::from("run")],
            &missing_cwd,
            None,
            true,
        )
        .expect_err("managed validation must run before returning a command");
        assert!(error.to_string().contains("cwd"));
    }

    #[tokio::test]
    async fn managed_launch_guard_runs_with_caller_thread_storage_context() {
        let storage = ManagedStorage::production();
        let command = storage.root().join("malformed-layout/agent");
        std::fs::create_dir_all(command.parent().unwrap()).unwrap();
        std::fs::write(&command, b"agent").unwrap();
        let executable = LocalExecutable {
            command,
            args: Vec::new(),
            env: BTreeMap::new(),
        };
        let cwd = tempfile::tempdir().unwrap();

        let error = prepare_provider_command(&executable, &[], cwd.path(), None)
            .await
            .expect_err("malformed managed layout must fail launch verification");

        assert!(
            error
                .to_string()
                .contains("managed provider launch rejected"),
            "{error}"
        );
    }
}
