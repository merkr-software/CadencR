//! Preservation assertions shared by archived and current Rust state probes.
use super::*;

pub(super) fn assert_managed_only_trace(remote: &Remote, previous: &Value) {
    let current = remote.control(json!({"action":"stats"}));
    let offset = previous["requests"].as_array().unwrap().len();
    for release in previous["releaseRecords"].as_array().unwrap() {
        let retained = current["releaseRecords"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == release["id"]);
        assert_eq!(retained, Some(release), "existing release record changed");
    }
    let providers: Vec<u64> = previous["releaseRecords"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|release| {
            !release["tag_name"]
                .as_str()
                .unwrap()
                .starts_with("catalog-")
        })
        .map(|release| release["id"].as_u64().unwrap())
        .collect();
    assert!(
        !providers.is_empty(),
        "existing provider release must be retained"
    );
    for request in &current["requests"].as_array().unwrap()[offset..] {
        let path = request["path"].as_str().unwrap();
        assert!(
            !path.starts_with("/public/acme/provider/"),
            "author download after retirement: {request}"
        );
        if request["method"] != "GET" {
            for id in &providers {
                let resource = format!("/releases/{id}");
                assert!(
                    !path.ends_with(&resource) && !path.contains(&format!("{resource}/")),
                    "existing provider release mutated: {request}"
                );
            }
        }
    }
}
pub(super) fn assert_resume_mutations(remote: &Remote, previous: &Value, interruption: &str) {
    let current = remote.control(json!({"action":"stats"}));
    let offset = previous["requests"].as_array().unwrap().len();
    let mutations: Vec<Value> = current["requests"].as_array().unwrap()[offset..]
        .iter()
        .filter(|request| request["method"] != "GET")
        .map(|request| json!([request["method"], request["path"]]))
        .collect();
    if interruption != "provider" {
        assert!(
            mutations.is_empty(),
            "completed remote state must not be rewritten: {mutations:?}"
        );
        assert_eq!(current["discovery"], previous["discovery"]);
        return;
    }
    let catalog = current["releaseRecords"]
        .as_array()
        .unwrap()
        .iter()
        .find(|release| {
            release["tag_name"]
                .as_str()
                .unwrap()
                .starts_with("catalog-")
        })
        .expect("only the catalog is created after interrupted provider verification");
    let id = catalog["id"].as_u64().unwrap();
    let expected = vec![
        json!(["POST", "/api/repos/acme/registry/git/refs"]),
        json!(["POST", "/api/repos/acme/registry/releases"]),
        json!([
            "POST",
            format!("/uploads/repos/acme/registry/releases/{id}/assets")
        ]),
        json!(["PATCH", format!("/api/repos/acme/registry/releases/{id}")]),
        json!([
            "PUT",
            "/api/repos/acme/registry/contents/managed-index.json"
        ]),
    ];
    assert_eq!(
        mutations, expected,
        "only five ordered catalog/discovery mutations are permitted"
    );
    assert_eq!(
        current["releaseRecords"].as_array().unwrap().len(),
        previous["releaseRecords"].as_array().unwrap().len() + 1
    );
}
pub(super) fn snapshot(directory: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, dir: &Path, result: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, result);
            } else {
                result.insert(
                    path.strip_prefix(root).unwrap().into(),
                    std::fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(directory, directory, &mut result);
    result
}
pub(super) fn assert_preserved(before: &BTreeMap<PathBuf, Vec<u8>>, state: &Path) {
    let after = snapshot(state);
    let transient: std::collections::BTreeSet<PathBuf> = before
        .iter()
        .filter(|(path, _)| path.ends_with("staging-receipt.json"))
        .flat_map(|(path, bytes)| {
            let receipt: crate::StageReceipt = serde_json::from_slice(bytes).unwrap();
            receipt
                .artifacts
                .into_iter()
                .map(|artifact| path.parent().unwrap().join(artifact.asset))
                .collect::<Vec<_>>()
        })
        .collect();
    for (path, bytes) in before {
        if transient.contains(path) {
            continue;
        }
        assert_eq!(after.get(path), Some(bytes), "preserve {}", path.display());
    }
}
pub(super) fn assert_complete(state: &Path) {
    let files = snapshot(state);
    for suffix in [
        "pipeline-request.json",
        "publication-manifest.json",
        "staging-receipt.json",
        "mirror-receipt.json",
        "publication-receipt.json",
        "managed-index.json",
        "catalog-publication-receipt.json",
        "discovery-receipt.json",
    ] {
        assert!(
            files.keys().any(|path| path.ends_with(suffix)),
            "missing {suffix}: {:?}",
            files.keys()
        );
    }
    assert!(!state.join(".pipeline.lock").exists());
}
