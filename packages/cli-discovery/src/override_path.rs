//! The user-chosen binary that short-circuits the regular search.

use std::path::Path;

use crate::error::{run_blocking, DiscoveryError};
use crate::types::{Candidate, CandidateSource, DiscoverySpec};
use crate::version::probe_version;
use crate::walk::canonicalize_executable;

/// The override as the sole candidate, or `None` when it is not an
/// executable file or does not pass the spec's version filter (the caller then
/// falls back to the regular search).
pub(crate) async fn override_candidate(
    spec: &DiscoverySpec,
    path: &Path,
) -> Result<Option<Candidate>, DiscoveryError> {
    let path_owned = path.to_path_buf();
    let canonical = run_blocking("override path check", move || {
        canonicalize_executable(&path_owned)
    })
    .await?;
    let Some(canonical) = canonical else {
        return Ok(None);
    };
    // Probe the override. Apply the substring filter too — a shim dressed as
    // the requested binary still wouldn't speak the expected protocol, so
    // silently dropping it is safer than honoring an override that will only
    // fail downstream.
    let probe = probe_version(path, &spec.version_args).await;
    let accept = match spec.version_must_contain.as_deref() {
        // Filter set: the substring alone is too lax, since the rustup shim's
        // "Unknown binary 'rust-analyzer'" error mentions the name and would
        // pass a contains-only check. A probe that never completed cannot be
        // validated either, so it is rejected, as in `discover_all`.
        Some(needle) => probe
            .as_ref()
            .is_some_and(|probe| probe.passes_filter(needle)),
        // No filter: keep behavior unchanged (returns a possibly versionless
        // candidate).
        None => true,
    };
    if !accept {
        return Ok(None);
    }
    Ok(Some(Candidate {
        path: path.to_path_buf(),
        canonical,
        version: probe.as_ref().and_then(|probe| probe.version),
        version_text: probe.and_then(|probe| probe.version_text),
        source: CandidateSource::Override,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::{dummy_spec, make_executable_with_body};
    use tempfile::TempDir;

    #[tokio::test]
    async fn a_probe_that_never_ran_rejects_the_override() {
        // A missing interpreter makes the probe fail outright. The filter
        // cannot validate such a binary, so the override must be dropped
        // instead of honoured unvalidated.
        let dir = TempDir::new().unwrap();
        let broken = make_executable_with_body(
            dir.path(),
            "thing",
            "#!/nonexistent/interpreter\necho 1.2.3\n",
        );
        let mut spec = dummy_spec();
        spec.version_must_contain = Some("thing".to_string());
        assert!(override_candidate(&spec, &broken).await.unwrap().is_none());
    }
}
