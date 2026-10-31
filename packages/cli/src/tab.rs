use std::path::Path;

use cadencr_plugin_core::tab::{
    check_backend_binary, describe_all, inspect_tab_folder, BinaryProblem, TabAccessLevel,
    TabManifest, TabPlatform,
};
use cadencr_tab_backend::conformance::{self, CheckStatus, Options, Report};

use crate::{operation_error, Diagnostic};

const FAILED: &str = "TAB_VALIDATION_FAILED";
const CONFORMANCE_FAILED: &str = "TAB_BACKEND_CONFORMANCE_FAILED";
/// This platform's backend binary is there but the host would refuse to
/// start it (a script, not native, the wrong CPU, unsigned arm64, not
/// executable, outside the folder…).
const BINARY_REFUSED: &str = "TAB_BACKEND_BINARY_REFUSED";
/// stderr lines of a failing backend quoted in the diagnostic.
const STDERR_LINES: usize = 10;

/// `cadencr plugin validate <folder> --kind tab`: the same folder inspection the
/// service runs before listing a custom tab, then — unless `run_backend` is
/// off — this platform's built backend run through the protocol conformance
/// checks. Warnings and an unbuilt entry or backend are reported but never
/// fail the command; a binary the host would refuse to start, or a failed
/// conformance check, does.
pub(crate) fn validate(
    folder: &Path,
    descriptor: Option<&Path>,
    run_backend: bool,
) -> Result<Option<String>, Diagnostic> {
    if descriptor.is_some() {
        return Err(operation_error(
            FAILED,
            "--descriptor is not used for custom tabs",
        ));
    }
    validate_folder(folder, run_backend).map(|(_, message)| Some(message))
}

/// [`validate`] without the argument check: the valid manifest and the
/// report line, for `--kind plugin` members too.
pub(crate) fn validate_folder(
    folder: &Path,
    run_backend: bool,
) -> Result<(TabManifest, String), Diagnostic> {
    let report = inspect_tab_folder(folder);
    let Some(manifest) = report.valid_manifest() else {
        return Err(operation_error(FAILED, report.findings.describe_errors()));
    };
    let mut message = format!(
        "valid custom tab: {} {} ({}); permissions hash {}",
        manifest.id,
        manifest.version,
        report.directory.display(),
        manifest.permissions_hash()
    );
    message.push_str(&access_note(manifest));
    for note in binary_notes(&report.directory, manifest) {
        message.push_str("; note: ");
        message.push_str(&note);
    }
    if !report.entry_present {
        message.push_str(&format!(
            "; note: entry `{}` is not built yet (run `npm run build`)",
            manifest.entry
        ));
    }
    if !report.findings.warnings.is_empty() {
        message.push_str("; warnings: ");
        message.push_str(&describe_all(&report.findings.warnings));
    }
    if let Some(note) = backend_conformance(&report.directory, manifest, run_backend)? {
        message.push_str(&note);
    }
    Ok((manifest.clone(), message))
}

/// Run this platform's backend binary through
/// `cadencr_tab_backend::conformance` the way the host starts it (the tab
/// folder as working directory, the manifest's `backend.protocol`). Nothing
/// to run when the tab has no backend for this platform or its binary is not
/// built yet: the inspection's `BACKEND_UNAVAILABLE` warning already says
/// so. A binary that is there but that the host would refuse fails with
/// [`BINARY_REFUSED`], `--no-run` or not.
fn backend_conformance(
    root: &Path,
    manifest: &TabManifest,
    run_backend: bool,
) -> Result<Option<String>, Diagnostic> {
    let (Some(backend), Some(platform)) = (manifest.backend.as_ref(), TabPlatform::current())
    else {
        return Ok(None);
    };
    let Some(relative) = backend.binary_for(platform) else {
        return Ok(None);
    };
    let binary = match check_backend_binary(root, relative, platform) {
        Ok(binary) => binary,
        Err(BinaryProblem::Missing) => return Ok(None),
        Err(problem) => {
            return Err(operation_error(
                BINARY_REFUSED,
                format!(
                    "backend `{relative}` for {platform} {problem}; Cadencr refuses to start it"
                ),
            ))
        }
    };
    if !run_backend {
        return Ok(Some(format!(
            "; note: backend `{relative}` was not run (--no-run), so its protocol conformance is unchecked"
        )));
    }
    let options = Options::builder()
        .cwd(root)
        .protocol(backend.protocol)
        .build();
    let report = conformance::run(&binary, &options);
    if !report.passed() {
        return Err(operation_error(
            CONFORMANCE_FAILED,
            conformance_failure(relative, platform, &report),
        ));
    }
    let names: Vec<&str> = report
        .checks
        .iter()
        .map(|check| check.name.as_str())
        .collect();
    Ok(Some(format!(
        "; backend conformance on {platform}: passed ({})",
        names.join(", ")
    )))
}

/// The failed checks first, then the full report and the backend's last
/// stderr lines.
fn conformance_failure(relative: &str, platform: TabPlatform, report: &Report) -> String {
    let failed: Vec<&str> = report
        .checks
        .iter()
        .filter(|check| check.status == CheckStatus::Failed)
        .map(|check| check.name.as_str())
        .collect();
    let mut message = format!(
        "backend `{relative}` for {platform} fails the protocol conformance checks \
         (docs/TAB_BACKEND_PROTOCOL.md): {}\n{report}",
        failed.join(", ")
    );
    let tail = &report.stderr_tail[report.stderr_tail.len().saturating_sub(STDERR_LINES)..];
    if tail.is_empty() {
        message.push_str("stderr: (empty)");
    } else {
        message.push_str("stderr (last lines):");
        for line in tail {
            message.push_str("\n  ");
            message.push_str(line);
        }
    }
    message
}

/// The tab's level, spelled out: what beyond its page it may run.
fn access_note(manifest: &TabManifest) -> String {
    match manifest.access_level() {
        TabAccessLevel::Ui => "; access: page only".into(),
        TabAccessLevel::Commands => {
            let programs: Vec<&str> = manifest
                .commands
                .iter()
                .map(|command| command.program.as_str())
                .collect();
            format!("; access: runs commands ({})", programs.join(", "))
        }
        TabAccessLevel::Backend => {
            let Some(backend) = manifest.backend.as_ref() else {
                return String::new();
            };
            let platforms: Vec<&str> = backend.platform_keys().collect();
            format!(
                "; access: native backend for {} (protocol {}), which runs with the user's rights",
                platforms.join(", "),
                backend.protocol
            )
        }
    }
}

/// Non-fatal notes on the backend binaries of the platforms Cadencr is not
/// running on: one missing or not native cannot run there. This platform's
/// binary is the inspection's own `BACKEND_UNAVAILABLE` warning ("not built
/// yet" when missing); a platform declaring none is named here.
fn binary_notes(root: &Path, manifest: &TabManifest) -> Vec<String> {
    let Some(backend) = manifest.backend.as_ref() else {
        return Vec::new();
    };
    let current = TabPlatform::current();
    let mut notes = Vec::new();
    for platform in TabPlatform::ALL {
        match backend.binary_for(platform) {
            None if Some(platform) == current => notes.push(format!(
                "the backend declares no binary for {platform}, so it is unavailable on this platform"
            )),
            Some(path) if Some(platform) != current => {
                if let Err(problem) = check_backend_binary(root, path, platform) {
                    notes.push(format!("backend binary `{path}` for {platform} {problem}"));
                }
            }
            _ => {}
        }
    }
    notes
}

pub(crate) fn pack(
    request: cadencr_registry_core::PackTabRequest<'_>,
) -> Result<Option<String>, crate::Diagnostic> {
    let archive = cadencr_registry_core::pack_tab(request)
        .map_err(|e| crate::operation_error("TAB_PACKAGING_FAILED", e))?;
    crate::output::write_receipt(
        &serde_json::json!({"kind":"tab", "archive":archive.archive,"sha256":archive.sha256,"size":archive.size}),
        "TAB_PACKAGING_FAILED",
    )
}
