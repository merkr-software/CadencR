//! Protected, replayable publication orchestration. No contributor code executes.
mod catalog;
mod request;
mod staging;
mod state;

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::github::discovery::DiscoveryClient;
use crate::github::{GitHubClient, ReleaseClient};
use crate::{CatalogPublicationReceipt, DiscoveryReceipt, Downloader, PublisherError};

/// Explicit protected-job inputs. The exact request digest is the confirmation.
#[derive(bon::Builder)]
pub struct PipelineRequest<'a> {
    pub request: &'a Path,
    pub directory: &'a Path,
    pub repository: &'a str,
    pub registry_commit: &'a str,
    pub private_key: &'a Path,
    pub confirm_request_sha256: &'a str,
}

/// Owned checked inputs. Fields cannot be changed between confirmation and execution.
pub struct PreparedPipeline {
    request: request::Request,
    binding: Value,
    directory: PathBuf,
    registry_commit: String,
    private_key: PathBuf,
    public_key: Vec<u8>,
    previous: Option<Vec<u8>>,
    entries: Vec<Entry>,
}

struct Entry {
    submission: Value,
    bytes: Vec<u8>,
    plan: Value,
    registry_commit: String,
    directory: PathBuf,
    require_published: bool,
}

impl Entry {
    fn tag(&self) -> &str {
        self.plan["release"]["tag"]
            .as_str()
            .expect("validated plan tag")
    }
    fn submission_file(&self) -> PathBuf {
        self.directory.join("submission.json")
    }
    fn stage_request<'a>(
        &'a self,
        repository: &'a str,
        submission: &'a Path,
    ) -> crate::StageRequest<'a> {
        crate::StageRequest::builder()
            .submission(submission)
            .repository(repository)
            .directory(&self.directory)
            .build()
    }
}

#[derive(Serialize)]
pub struct PipelineReceipt {
    pub catalog: CatalogPublicationReceipt,
    pub discovery: DiscoveryReceipt,
}

/// Local bounded validation only: no state writes, signatures, credentials or network.
pub fn prepare_registry_publication(
    input: PipelineRequest<'_>,
) -> Result<PreparedPipeline, PublisherError> {
    request::prepare(input)
}

/// Execute a checked request with credentials supplied only after local preflight.
pub fn publish_registry(
    prepared: PreparedPipeline,
    token: &str,
) -> Result<PipelineReceipt, PublisherError> {
    request::revalidate(&prepared)?;
    let client = GitHubClient::new(&prepared.request.repository, token)?;
    run(
        &prepared,
        &client,
        &crate::download::ProductionDownloader::default(),
        &crate::download::DiscoveryDownloader::default(),
    )
}

trait PipelineClient: ReleaseClient + DiscoveryClient {
    fn ensure_tag(&self, tag: &str, commit: &str) -> Result<(), PublisherError>;
}
impl PipelineClient for GitHubClient {
    fn ensure_tag(&self, tag: &str, commit: &str) -> Result<(), PublisherError> {
        self.ensure_publication_tag(tag, commit)
    }
}

fn run(
    prepared: &PreparedPipeline,
    client: &impl PipelineClient,
    downloader: &impl Downloader,
    discovery: &impl Downloader,
) -> Result<PipelineReceipt, PublisherError> {
    request::revalidate(prepared)?;
    state::ensure_directory(&prepared.directory)?;
    let lock = crate::fs::OwnedLock::acquire(&prepared.directory.join(".pipeline.lock"))?;
    let result = run_locked(prepared, client, downloader, discovery);
    match result {
        Ok(receipt) => {
            lock.release(None)?;
            Ok(receipt)
        }
        Err(error) => {
            lock.release(Some(error))?;
            unreachable!("lock release returns primary error")
        }
    }
}

fn run_locked(
    prepared: &PreparedPipeline,
    client: &impl PipelineClient,
    downloader: &impl Downloader,
    discovery: &impl Downloader,
) -> Result<PipelineReceipt, PublisherError> {
    state::materialize(prepared)?;
    let published = staging::stage_all(prepared, client, downloader)?;
    let manifest = state::manifest(prepared);
    let manifest_file = prepared.directory.join("publication-manifest.json");
    state::write_json_once(&manifest_file, &manifest)?;
    for (entry, published) in prepared.entries.iter().zip(published) {
        publish_entry(entry, prepared, published, client, downloader)?;
    }
    let snapshot = catalog::prepare_candidate(prepared, &manifest_file, downloader)?;
    client.ensure_tag(snapshot.tag(), &prepared.registry_commit)?;
    let catalog = crate::catalog_publish::lifecycle::publish_with(
        &snapshot,
        &manifest_file,
        &prepared.directory,
        client,
        downloader,
    )?;
    crate::catalog_discovery::preflight(
        &snapshot,
        &manifest_file,
        &prepared.directory,
        &prepared.request.discovery_branch,
    )?;
    let discovery = crate::catalog_discovery::lifecycle::advance_preflighted(
        &snapshot,
        &manifest_file,
        &prepared.directory,
        &prepared.request.discovery_branch,
        client,
        downloader,
        discovery,
    )?;
    Ok(PipelineReceipt { catalog, discovery })
}

fn publish_entry(
    entry: &Entry,
    prepared: &PreparedPipeline,
    published: bool,
    client: &impl PipelineClient,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    let repository = &prepared.request.repository;
    let submission = entry.submission_file();
    if !published {
        client.ensure_tag(entry.tag(), &entry.registry_commit)?;
        crate::mirror::mirror(
            entry.stage_request(repository, &submission),
            &entry.registry_commit,
            client,
        )?;
    }
    // Managed restoration recovers local mirror proof for public releases. The
    // ordinary promoter independently validates release/tag/assets before replay.
    crate::promote::promote(
        entry.stage_request(repository, &submission),
        crate::promote::PromotionExpectation::builder()
            .registry_commit(&entry.registry_commit)
            .release_tag(entry.tag())
            .build(),
        client,
        downloader,
    )?;
    Ok(())
}

#[cfg(test)]
mod fixture;
#[cfg(test)]
mod handoff;
#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;

    #[test]
    fn complete_pipeline_lost_responses_and_replay_preserve_immutable_outputs() {
        let fixture = Fixture::new();
        fixture.client.lose_responses.set(true);
        let receipt = fixture.run().unwrap();
        assert_eq!(receipt.discovery.status, "discovery_verified");
        let catalog = std::fs::read(fixture.state.join("managed-index.json")).unwrap();
        let binding = std::fs::read(fixture.state.join("pipeline-request.json")).unwrap();
        let before = fixture.client.writes.get();
        fixture.client.dead_sources.set(true);
        fixture.run().unwrap();
        assert_eq!(fixture.client.writes.get(), before);
        assert_eq!(
            std::fs::read(fixture.state.join("managed-index.json")).unwrap(),
            catalog
        );
        assert_eq!(
            std::fs::read(fixture.state.join("pipeline-request.json")).unwrap(),
            binding
        );
        let prepared = fixture.prepare().unwrap();
        for target in prepared.entries[0].plan["targets"].as_array().unwrap() {
            std::fs::remove_file(
                prepared.entries[0]
                    .directory
                    .join(target["asset"].as_str().unwrap()),
            )
            .unwrap();
        }
        fixture.client.requests.borrow_mut().clear();
        fixture.run().unwrap();
        assert!(fixture
            .client
            .requests
            .borrow()
            .iter()
            .all(|url| !url.contains("/acme/")));
        assert_eq!(fixture.client.writes.get(), before);
        assert!(!fixture.state.join(".pipeline.lock").exists());
    }

    #[test]
    fn malformed_policy_keys_continuity_and_state_conflicts_fail_before_writes() {
        for mode in [
            "unknown",
            "commit",
            "path",
            "repository",
            "key",
            "timestamp",
            "symlink",
            "state",
        ] {
            let fixture = Fixture::new();
            let mut value = fixture.request_value();
            match mode {
                "unknown" => value["execute"] = "contributor.sh".into(),
                "commit" => value["publications"][0]["registry_commit"] = "main".into(),
                "path" => value["publications"][0]["submission"] = "../submission.json".into(),
                "repository" => value["repository"] = "other/registry".into(),
                "key" => {
                    std::fs::write(&fixture.private, PUBLIC).unwrap();
                }
                "timestamp" => value["expires_at"] = "2000-01-01T00:00:00Z".into(),
                "symlink" => {
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(fixture.root.path(), &fixture.state).unwrap();
                }
                "state" => {
                    state::ensure_directory(&fixture.state).unwrap();
                    std::fs::write(fixture.state.join("pipeline-request.json"), b"{}").unwrap();
                }
                _ => unreachable!(),
            }
            fixture.write_request(value);
            assert!(fixture.prepare().is_err(), "{mode}");
            assert_eq!(fixture.client.writes.get(), 0);
            assert!(!fixture.state.join("managed-index.json").exists());
        }
    }

    #[test]
    fn equivalent_pretty_manifest_replays_without_overwriting_bytes_or_remote_writes() {
        let fixture = Fixture::new();
        fixture.run().unwrap();
        let manifest_file = fixture.state.join("publication-manifest.json");
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
        let pretty = serde_json::to_vec_pretty(&manifest).unwrap();
        std::fs::write(&manifest_file, &pretty).unwrap();
        let before = fixture.client.writes.get();
        fixture.client.dead_sources.set(true);
        fixture.run().unwrap();
        assert_eq!(fixture.client.writes.get(), before);
        assert_eq!(std::fs::read(&manifest_file).unwrap(), pretty);
    }

    #[test]
    fn failed_public_verification_never_signs_or_advances_discovery() {
        let fixture = Fixture::new();
        fixture.client.fail_public.set(true);
        assert!(fixture.run().is_err());
        assert!(!fixture.state.join("managed-index.json").exists());
        assert!(!fixture.state.join("discovery-receipt.json").exists());
        assert!(!fixture.state.join(".pipeline.lock").exists());
    }

    #[test]
    fn signed_baseline_requires_existing_publication_and_never_reacquires_sources() {
        let mut fixture = Fixture::new();
        fixture.run().unwrap();
        let prior = std::fs::read(fixture.state.join("managed-index.json")).unwrap();
        std::fs::write(
            fixture.request.parent().unwrap().join("previous.json"),
            prior,
        )
        .unwrap();
        let mut request = fixture.request_value();
        request["previous_index"] = "previous.json".into();
        let output = std::process::Command::new("node")
            .args([
                "-e",
                "console.log(new Date(Date.now()-30000).toISOString().replace(/\\.\\d{3}Z$/,'Z'))",
            ])
            .output()
            .unwrap();
        request["generated_at"] = String::from_utf8(output.stdout).unwrap().trim().into();
        fixture.write_request(request);
        fixture.state = fixture.state.parent().unwrap().join("next-state");
        fixture.client.dead_sources.set(true);
        fixture.client.requests.borrow_mut().clear();
        let prepared = fixture.prepare().unwrap();
        assert!(prepared.entries[0].require_published);
        let tag = prepared.entries[0].tag().to_owned();
        fixture
            .client
            .releases
            .borrow_mut()
            .get_mut(&tag)
            .unwrap()
            .draft = true;
        assert!(fixture
            .run()
            .err()
            .unwrap()
            .to_string()
            .contains("baseline"));
        assert!(fixture.client.requests.borrow().is_empty());
        fixture
            .client
            .releases
            .borrow_mut()
            .get_mut(&tag)
            .unwrap()
            .draft = false;
        fixture.run().unwrap();
        assert!(fixture
            .client
            .requests
            .borrow()
            .iter()
            .all(|url| !url.contains("/acme/")));
    }

    #[test]
    fn tampered_local_catalog_or_discovery_proof_is_rejected_without_remote_mutation() {
        for name in [
            "managed-index.json",
            "catalog-publication-receipt.json",
            "discovery-receipt.json",
        ] {
            let fixture = Fixture::new();
            fixture.run().unwrap();
            let before = fixture.client.writes.get();
            std::fs::write(fixture.state.join(name), b"{}").unwrap();
            assert!(fixture.prepare().is_err(), "{name}");
            assert_eq!(fixture.client.writes.get(), before);
        }
    }

    #[test]
    fn private_key_change_between_preflight_and_execution_is_rejected_without_state() {
        let fixture = Fixture::new();
        let prepared = fixture.prepare().unwrap();
        std::fs::write(&fixture.private, PUBLIC).unwrap();
        assert!(run(&prepared, &fixture.client, &fixture.client, &fixture.client).is_err());
        assert!(!fixture.state.exists());
        assert_eq!(fixture.client.writes.get(), 0);
    }
}
