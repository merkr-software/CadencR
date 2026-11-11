//! What starting one tab's backend takes: the native executable it may run on
//! this platform, and its `hello` line.

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use cadencr_plugin_core::tab::{check_backend_binary, BinaryProblem, TabBackend, TabPlatform};
use cadencr_tab_backend::protocol::{ApiInfo, Hello, HostMessage, PluginInfo, TOKEN_HEADER};

use super::super::managed::policy::{self, PolicySubject};
use super::super::managed::storage::{ManagedFacts, RevisionLease};
use super::super::policy::Scope;
use super::process::Prepared;
use crate::error::AppError;
use crate::remote::secure_fs::create_dir_owner_only;

/// Everything needed to start one tab's backend in one conversation.
#[derive(Debug, Clone)]
pub struct BackendLaunch {
    pub plugin_id: String,
    pub plugin_version: String,
    pub project_id: i64,
    pub feature_id: i64,
    /// The tab folder (canonical): the backend's working directory. Read-only
    /// for a marketplace tab (an immutable revision).
    pub plugin_dir: PathBuf,
    /// The tab's own writable folder ([`super::super::paths::state_dir`]),
    /// sent in `hello` and created before the backend starts.
    pub state_dir: PathBuf,
    /// The conversation's folder, sent in `hello`.
    pub worktree: PathBuf,
    pub backend: TabBackend,
    pub scopes: Vec<Scope>,
    pub permissions_hash: String,
    /// `http://127.0.0.1:<port>`, for the backend's own API calls.
    pub api_base_url: String,
    /// A marketplace tab's signed `executable_sha256`: the binary is hashed
    /// right before it starts and refused when it differs. `None` for a
    /// local tab, whose author rebuilds it at will.
    pub expected_sha256: Option<String>,
    /// A marketplace revision's signed facts, checked against the revocation
    /// policy right before every start (not before each request: a running
    /// backend keeps serving while the policy is merely out of date).
    pub managed: Option<ManagedFacts>,
    /// Pins a marketplace tab's revision (the backend's working directory)
    /// for as long as the backend runs, so an update cannot reclaim it.
    pub lease: Option<RevisionLease>,
}

impl BackendLaunch {
    /// The revocation policy lets this marketplace revision start (a local
    /// tab always may). Cheap: the policy is in memory.
    fn check_policy(&self) -> Result<(), AppError> {
        match &self.managed {
            Some(facts) => policy::current()?.require_backend_start(PolicySubject::installed(
                &self.plugin_id,
                &self.plugin_version,
                facts,
            )),
            None => Ok(()),
        }
    }

    /// The checked executable to run on the platform Cadencr runs on: a
    /// native file inside the tab folder and, for a marketplace tab, the
    /// exact bytes its signed package names (409 `PLUGIN_BACKEND_TAMPERED`).
    /// Blocking: it may hash up to 64 MiB.
    fn verified_executable(&self) -> Result<PathBuf, AppError> {
        let path = resolve_executable(&self.plugin_dir, &self.backend, TabPlatform::current())?;
        if let Some(expected) = &self.expected_sha256 {
            verify_digest(&path, expected)?;
        }
        Ok(path)
    }

    /// Every check of a start and its `ready` budget: the revocation policy
    /// (not blocked, 403 `PLUGIN_TAB_BLOCKED`, and vouched for by a fresh
    /// policy when a feed is configured, 409 `MANAGED_TAB_POLICY_UNAVAILABLE`),
    /// then [`Self::verified_executable`] and the state folder off the async
    /// runtime: hashing a large binary takes a while, and must hold up no
    /// other request.
    pub(super) async fn prepare(&self) -> Result<Prepared, AppError> {
        self.check_policy()?;
        let launch = self.clone();
        tokio::task::spawn_blocking(move || {
            let executable = launch.verified_executable()?;
            launch.prepare_state_dir()?;
            let ready_budget = super::first_start::ready_budget(&executable);
            Ok(Prepared {
                executable,
                ready_budget,
            })
        })
        .await
        .map_err(|error| unavailable(format!("the backend's start checks failed: {error}")))?
    }

    /// Create [`Self::state_dir`] and its `tab-state` parent, private to the
    /// user (0700), so other users cannot list which tabs are installed.
    pub(super) fn prepare_state_dir(&self) -> Result<(), AppError> {
        let parent = self
            .state_dir
            .parent()
            .map_or(Ok(()), create_dir_owner_only);
        parent
            .and_then(|()| create_dir_owner_only(&self.state_dir))
            .map_err(|error| {
                unavailable(format!(
                    "the backend's state folder {} cannot be created: {error:#}",
                    self.state_dir.display()
                ))
            })
    }

    /// The first stdin line.
    pub(super) fn hello(&self, token: &str) -> Result<String, AppError> {
        serde_json::to_string(&HostMessage::Hello(Hello {
            protocol: self.backend.protocol,
            plugin: PluginInfo {
                id: self.plugin_id.clone(),
                version: self.plugin_version.clone(),
            },
            project_id: self.project_id,
            feature_id: self.feature_id,
            worktree: self.worktree.clone(),
            state_dir: self.state_dir.clone(),
            scopes: self
                .scopes
                .iter()
                .map(|scope| scope.as_str().to_owned())
                .collect(),
            api: ApiInfo {
                base_url: self.api_base_url.clone(),
                token_header: TOKEN_HEADER.to_owned(),
                token: token.to_owned(),
            },
        }))
        .map_err(|error| unavailable(format!("the backend's `hello` cannot be encoded: {error}")))
    }
}

/// `backend.binary[platform]` inside the tab folder `root` (canonical), when
/// it is a regular, executable, native file there. Never a program on `PATH`
/// and never a script: what the user consented to is that file.
fn resolve_executable(
    root: &Path,
    backend: &TabBackend,
    platform: Option<TabPlatform>,
) -> Result<PathBuf, AppError> {
    let Some(platform) = platform else {
        return Err(unavailable_on_platform(
            "custom tab backends are not supported on this platform yet".into(),
        ));
    };
    let Some(relative) = backend.binary_for(platform) else {
        return Err(unavailable_on_platform(format!(
            "this tab's backend ships no binary for {platform} (it declares: {})",
            backend.platform_keys().collect::<Vec<_>>().join(", ")
        )));
    };
    check_backend_binary(root, relative, platform).map_err(|problem| {
        let message = format!("the tab's backend `{relative}` {problem}");
        match problem {
            BinaryProblem::Unsigned => AppError::coded(
                StatusCode::UNPROCESSABLE_ENTITY,
                "PLUGIN_BACKEND_UNSIGNED",
                message,
            ),
            problem if problem.is_wrong_format() => AppError::coded(
                StatusCode::UNPROCESSABLE_ENTITY,
                "PLUGIN_BACKEND_NOT_NATIVE",
                message,
            ),
            _ => unavailable(message),
        }
    })
}

/// Stream-hash the binary about to run against its signed digest. What
/// runs is the file as it is now; a same-user swap between this check and
/// the exec is outside what Cadencr defends (the user's own account).
fn verify_digest(path: &Path, expected: &str) -> Result<(), AppError> {
    let tampered = |detail: String| {
        AppError::coded(
            StatusCode::CONFLICT,
            "PLUGIN_BACKEND_TAMPERED",
            format!(
                "the tab's backend {} {detail}; reinstall the tab from the marketplace",
                path.display()
            ),
        )
    };
    let (actual, _) = crate::shared::file_digest::sha256_regular_file(
        path,
        cadencr_registry_core::MAX_TAB_BACKEND_EXECUTABLE_BYTES,
    )
    .map_err(|error| tampered(format!("cannot be verified ({error})")))?;
    if actual != expected {
        return Err(tampered(
            "differs from the binary its signed package names".into(),
        ));
    }
    Ok(())
}

/// 422 `PLUGIN_BACKEND_UNAVAILABLE`: the backend cannot start.
pub(super) fn unavailable(message: String) -> AppError {
    AppError::coded(
        StatusCode::UNPROCESSABLE_ENTITY,
        "PLUGIN_BACKEND_UNAVAILABLE",
        message,
    )
}

/// 422 `PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM`: no binary for this platform.
pub fn unavailable_on_platform(message: String) -> AppError {
    AppError::coded(
        StatusCode::UNPROCESSABLE_ENTITY,
        "PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM",
        message,
    )
}

#[cfg(test)]
pub(super) mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;
    use crate::domain::plugin_tabs::test_support::error_code;

    /// A launch of the backend at `relative` (for this platform) in `dir`.
    pub(in crate::domain::plugin_tabs::backend) fn launch_in(
        dir: &Path,
        relative: &str,
    ) -> BackendLaunch {
        let platform = TabPlatform::current().expect("tests run on a supported platform");
        BackendLaunch {
            plugin_id: "tab".into(),
            plugin_version: "0.1.0".into(),
            project_id: 1,
            feature_id: 2,
            plugin_dir: dir.to_path_buf(),
            state_dir: dir.join(".state"),
            worktree: dir.to_path_buf(),
            backend: TabBackend {
                protocol: 1,
                binary: BTreeMap::from([(platform.as_str().into(), relative.into())]),
                reasoning: Some("r".into()),
            },
            scopes: vec![Scope::FeaturesRead],
            permissions_hash: "h".into(),
            api_base_url: "http://127.0.0.1:1".into(),
            expected_sha256: None,
            managed: None,
            lease: None,
        }
    }

    /// Every check [`BackendLaunch::prepare`] makes of the executable.
    fn executable(launch: &BackendLaunch) -> Result<PathBuf, AppError> {
        launch.check_policy()?;
        launch.verified_executable()
    }

    fn code(result: Result<PathBuf, AppError>) -> &'static str {
        error_code(&result.unwrap_err())
    }

    /// Write `bytes` to `path` (its folders created) as an executable.
    #[cfg(unix)]
    pub(in crate::domain::plugin_tabs::backend) fn write_executable(path: &Path, bytes: &[u8]) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn tab_folder() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("tab")).unwrap();
        let dir = root.path().join("tab").canonicalize().unwrap();
        (root, dir)
    }

    #[test]
    fn a_platform_without_a_binary_is_unavailable_and_nothing_runs() {
        let (_root, dir) = tab_folder();
        let mut launch = launch_in(&dir, "bin/backend");
        let elsewhere = TabPlatform::ALL
            .into_iter()
            .find(|platform| Some(*platform) != TabPlatform::current())
            .unwrap();
        launch.backend.binary = BTreeMap::from([(elsewhere.as_str().into(), "bin/x".into())]);
        let error = executable(&launch).unwrap_err();
        assert!(error.to_string().contains(elsewhere.as_str()), "{error}");
        assert_eq!(error_code(&error), "PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM");
        assert_eq!(
            code(resolve_executable(&dir, &launch.backend, None)),
            "PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM"
        );
    }

    #[cfg(unix)]
    #[test]
    fn only_a_native_executable_inside_the_tab_folder_runs() {
        use std::os::unix::fs::symlink;
        let (root, dir) = tab_folder();
        let native = cadencr_plugin_core::tab::test_support::native_executable(
            TabPlatform::current().unwrap(),
        );
        write_executable(&dir.join("bin/backend"), &native);
        assert_eq!(
            executable(&launch_in(&dir, "bin/backend")).unwrap(),
            dir.join("bin/backend")
        );
        assert_eq!(
            code(executable(&launch_in(&dir, "bin/missing"))),
            "PLUGIN_BACKEND_UNAVAILABLE"
        );
        assert_eq!(
            code(executable(&launch_in(&dir, "bin/../../outside"))),
            "PLUGIN_BACKEND_UNAVAILABLE"
        );
        // A symlink out of the folder is refused, native target or not.
        write_executable(&root.path().join("outside"), &native);
        symlink(root.path().join("outside"), dir.join("bin/escape")).unwrap();
        let escape = executable(&launch_in(&dir, "bin/escape")).unwrap_err();
        assert!(
            escape.to_string().contains("outside the tab folder"),
            "{escape}"
        );
        assert_eq!(error_code(&escape), "PLUGIN_BACKEND_UNAVAILABLE");
        write_executable(&dir.join("bin/script"), b"#!/bin/sh\nexit 0\n");
        let script = executable(&launch_in(&dir, "bin/script")).unwrap_err();
        assert!(script.to_string().contains("script"), "{script}");
        assert_eq!(error_code(&script), "PLUGIN_BACKEND_NOT_NATIVE");
        write_executable(&dir.join("bin/text"), b"console.log('hi')\n");
        assert_eq!(
            code(executable(&launch_in(&dir, "bin/text"))),
            "PLUGIN_BACKEND_NOT_NATIVE"
        );
        let launch = launch_in(&dir, "bin/backend");
        launch.prepare_state_dir().unwrap();
        launch.prepare_state_dir().unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &std::path::Path| {
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777
            };
            assert_eq!(mode(&launch.state_dir), 0o700);
            assert_eq!(mode(launch.state_dir.parent().unwrap()), 0o700);
        }
        let hello: serde_json::Value =
            serde_json::from_str(&launch.hello("secret").unwrap()).unwrap();
        assert_eq!(hello["state_dir"], json!(dir.join(".state")));
        assert_eq!(
            (hello["type"].clone(), hello["protocol"].clone()),
            (json!("hello"), json!(1))
        );
        assert_eq!(hello["api"]["token"], "secret");
        // The header the service authorizes plugin tokens by.
        assert_eq!(
            hello["api"]["token_header"],
            crate::domain::plugin_tabs::principal::PLUGIN_TOKEN_HEADER
        );
        assert_eq!(hello["scopes"], json!(["features:read"]));
    }

    #[cfg(unix)]
    #[test]
    fn a_marketplace_binary_runs_only_with_its_signed_digest() {
        let (_root, dir) = tab_folder();
        let native = cadencr_plugin_core::tab::test_support::native_executable(
            TabPlatform::current().unwrap(),
        );
        write_executable(&dir.join("bin/backend"), &native);
        let mut launch = launch_in(&dir, "bin/backend");
        launch.expected_sha256 = Some(crate::domain::marketplace::storage::digest(&native));
        assert_eq!(executable(&launch).unwrap(), dir.join("bin/backend"));
        // One appended byte: still native, no longer the signed binary.
        let mut tampered = native.clone();
        tampered.push(0);
        std::fs::remove_file(dir.join("bin/backend")).unwrap();
        write_executable(&dir.join("bin/backend"), &tampered);
        let error = executable(&launch).unwrap_err();
        assert!(error.to_string().contains("signed package"), "{error}");
        assert_eq!(error_code(&error), "PLUGIN_BACKEND_TAMPERED");
        // A local tab's binary is whatever its author built.
        launch.expected_sha256 = None;
        assert!(executable(&launch).is_ok());
    }
}
