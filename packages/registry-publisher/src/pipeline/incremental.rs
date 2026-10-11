//! Incremental orchestration regression coverage.
use super::fixture::*;
use super::*;

#[test]
fn signed_catalog_renewal_never_restores_provider_archives() {
    let mut fixture = Fixture::new();
    fixture.run().unwrap();
    let prior = std::fs::read(fixture.state.join("managed-index.json")).unwrap();
    let original: Value = serde_json::from_slice(&prior).unwrap();
    let packages = (0..120)
        .map(|patch| {
            let mut package = original["signed"]["packages"][0].clone();
            package["agent"]["version"] = format!("1.0.{patch}").into();
            package["agent"]["description"] = "x".repeat(10_000).into();
            package
        })
        .collect();
    let payload = cadencr_registry_core::prepare_publication_index()
        .packages(packages)
        .generated_at(original["signed"]["generated_at"].as_str().unwrap())
        .expires_at(original["signed"]["expires_at"].as_str().unwrap())
        .call()
        .unwrap();
    let prior = cadencr_registry_core::sign_prepared_index(
        payload,
        &fixture.private,
        original["signature"]["key_id"].as_str().unwrap(),
    )
    .unwrap();
    assert!(prior.len() > 1024 * 1024);
    let previous: Value = serde_json::from_slice(&prior).unwrap();
    std::fs::write(
        fixture.request.parent().unwrap().join("previous.json"),
        &prior,
    )
    .unwrap();
    // The protected baseline and discovery head must refer to the same envelope.
    let head = fixture.client.get_discovery("main").unwrap().unwrap();
    fixture
        .client
        .set_discovery(
            crate::github::discovery::SetDiscoveryRequest::builder()
                .branch("main")
                .bytes(&prior)
                .expected_sha(&head.sha)
                .build(),
        )
        .unwrap();
    let mut request = fixture.request_value();
    request["previous_index"] = "previous.json".into();
    request["publications"] = serde_json::json!([]);
    let output = std::process::Command::new("node")
        .args([
            "-e",
            "console.log(new Date(Date.now()-30000).toISOString().replace(/\\.\\d{3}Z$/,'Z'))",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    request["generated_at"] = String::from_utf8(output.stdout).unwrap().trim().into();
    fixture.write_request(request);
    fixture.state = fixture.state.parent().unwrap().join("renewal-state");
    fixture.client.dead_sources.set(true);
    fixture.client.requests.borrow_mut().clear();
    assert!(fixture.prepare().unwrap().entries.is_empty());
    fixture.run().unwrap();
    let current: Value =
        serde_json::from_slice(&std::fs::read(fixture.state.join("managed-index.json")).unwrap())
            .unwrap();
    assert_eq!(
        current["signed"]["packages"],
        previous["signed"]["packages"]
    );
    assert!(fixture
        .client
        .requests
        .borrow()
        .iter()
        .all(|url| { !url.contains("/acme/") && !url.contains("/provider-") }));
    assert!(std::fs::read_dir(fixture.state.join("publications"))
        .unwrap()
        .next()
        .is_none());
}
