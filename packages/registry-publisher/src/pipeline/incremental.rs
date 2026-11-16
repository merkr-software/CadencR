//! Incremental orchestration regression coverage.
use super::fixture::*;
use super::*;

#[test]
fn administrative_retirement_uses_the_protected_pipeline_and_never_rewrites_mirrors() {
    let mut fixture = Fixture::new();
    let base = fixture.request.parent().unwrap().to_path_buf();
    let mut submission: Value =
        serde_json::from_slice(&std::fs::read(base.join("submission.json")).unwrap()).unwrap();
    submission["schema_version"] = serde_json::json!(2);
    submission["package"] = serde_json::json!({"kind":"provider","package":submission["package"]});
    std::fs::write(
        base.join("submission.json"),
        serde_json::to_vec(&submission).unwrap(),
    )
    .unwrap();
    let mut request = fixture.request_value();
    request["schema_version"] = serde_json::json!(2);
    request["discovery_branch"] = serde_json::json!("marketplace-v2-admin");
    fixture.client.branch.replace("marketplace-v2-admin".into());
    fixture.write_request(request);
    fixture.run().unwrap();
    let original = std::fs::read(fixture.state.join("managed-index.json")).unwrap();
    let envelope: Value = serde_json::from_slice(&original).unwrap();
    let old = &envelope["signed"]["packages"][0];
    use sha2::{Digest as _, Sha256};
    let digest = crate::hex(&Sha256::digest(
        cadencr_registry_core::canonical_json_bytes(old),
    ));
    let records = serde_json::json!([{"provider_id":"acme",
        "from":{"publisher":"acme","repository":"https://github.com/acme/provider"},
        "to":{"publisher":"independent","repository":"https://github.com/independent/provider"},
        "retired_versions":{"1.0.0":digest},
        "authorization":"https://github.com/cadencr/registry/pull/22#issuecomment-1","reason":"Explicit retirement and ownership transfer"}]);
    for (step, delta) in [(1, records.clone()), (2, serde_json::json!([]))] {
        std::fs::write(
            base.join("previous.json"),
            std::fs::read(fixture.state.join("managed-index.json")).unwrap(),
        )
        .unwrap();
        let mut request = fixture.request_value();
        request["previous_index"] = serde_json::json!("previous.json");
        request["publications"] = serde_json::json!([]);
        request["provider_handoffs"] = delta;
        let time = chrono::DateTime::parse_from_rfc3339(request["generated_at"].as_str().unwrap())
            .unwrap()
            + chrono::Duration::seconds(1);
        request["generated_at"] =
            serde_json::json!(time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        fixture.write_request(request);
        fixture.state = base.join(format!("administrative-{step}"));
        fixture.client.dead_sources.set(true);
        fixture.client.requests.borrow_mut().clear();
        fixture.run().unwrap();
        let writes = fixture.client.writes.get();
        fixture.run().unwrap();
        assert_eq!(fixture.client.writes.get(), writes);
        let current: Value = serde_json::from_slice(
            &std::fs::read(fixture.state.join("managed-index.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            current["signed"]["packages"],
            envelope["signed"]["packages"]
        );
        assert_eq!(current["signed"]["provider_handoffs"], records);
        assert!(fixture
            .client
            .requests
            .borrow()
            .iter()
            .all(|url| !url.contains("/provider-")));
    }
}

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
