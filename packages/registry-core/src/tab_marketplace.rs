//! Custom tab publication uses the same signed, immutable schema-2 envelope.
#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::{json, Value};

    fn package() -> Value {
        json!({"kind":"tab","package":{
            "tab":{"id":"files-graph","name":"Files graph","description":"Explore changes",
                "version":"1.0.0","repository":"https://github.com/acme/tabs","license":"MIT",
                "api_version":1,"distribution":{
                    "archive":"https://github.com/acme/tabs/releases/download/v1.0.0/tab.tar.gz",
                    "sha256":"a".repeat(64)}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"0.13.1"}}
        }})
    }

    #[test]
    fn tab_submission_and_mirror_preserve_identity_and_provenance() {
        let entry = package();
        assert!(matches!(
            parse_marketplace_package(&entry).unwrap(),
            MarketplacePackage::Tab(_)
        ));
        assert_eq!(
            marketplace_package_identity(&entry),
            Some(("files-graph", "1.0.0"))
        );
        let submission = json!({"schema_version":2,"package":entry,"source":{
            "repository":"https://github.com/acme/tabs","commit":"b".repeat(40),"tag":"v1.0.0"
        },"changelog":"First custom tab release"});
        validate_submission(&submission).unwrap();
        let plan = create_publication_plan(&submission, "cadencr/registry").unwrap();
        assert_eq!(plan["release"]["tag"], "tab-files-graph-v1.0.0");
        assert_eq!(plan["targets"][0]["target"], "tab");
        assert_eq!(plan["targets"][0]["asset"], "tab.tar.gz");
        assert_eq!(
            plan["mirrored_package"]["package"]["tab"]["repository"],
            "https://github.com/acme/tabs"
        );
        assert_eq!(
            plan["mirrored_package"]["package"]["tab"]["distribution"]["repository"],
            "https://github.com/cadencr/registry"
        );
        validate_marketplace_package(&plan["mirrored_package"]).unwrap();
        let mut wrong_tag = submission;
        wrong_tag["source"]["tag"] = json!("v2.0.0");
        assert!(validate_submission(&wrong_tag).is_err());
    }

    fn backend_submission() -> Value {
        let mut entry = crate::tab_backend::tests::package();
        entry["package"]["tab"]["repository"] = json!("https://github.com/acme/port-monitor");
        json!({"schema_version":2,"package":entry,"source":{
            "repository":"https://github.com/acme/port-monitor","commit":"b".repeat(40),"tag":"v1.2.0"
        },"changelog":"Native backend release"})
    }

    #[test]
    fn backend_tabs_plan_one_target_per_platform_and_mirror_every_archive() {
        let submission = backend_submission();
        validate_submission(&submission).unwrap();
        let plan = create_publication_plan(&submission, "cadencr/registry").unwrap();
        let release =
            "https://github.com/cadencr/registry/releases/download/tab-port-monitor-v1.2.0";
        let targets = plan["targets"].as_array().unwrap();
        let names: Vec<&str> = targets
            .iter()
            .map(|t| t["target"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "tab",
                "backend-darwin-aarch64",
                "backend-darwin-x86_64",
                "backend-linux-x86_64"
            ]
        );
        let sha = "b".repeat(64);
        let linux = &targets[3];
        assert_eq!(linux["asset"], format!("backend-linux-x86_64-{sha}.tar.gz"));
        assert_eq!(
            linux["source_url"],
            format!(
                "{}/tab-backend-linux-x86_64.tar.gz",
                crate::tab_backend::tests::RELEASE
            )
        );
        assert_eq!(linux["sha256"], sha);
        let mirrored = &plan["mirrored_package"];
        validate_marketplace_package(mirrored).unwrap();
        let binary = &mirrored["package"]["tab"]["distribution"]["binary"];
        for (index, platform) in cadencr_plugin_core::tab::TabPlatform::ALL
            .iter()
            .enumerate()
        {
            let platform = platform.as_str();
            let destination = format!("{release}/backend-{platform}-{sha}.tar.gz");
            assert_eq!(binary[platform]["archive"], destination);
            assert_eq!(targets[index + 1]["destination_url"], destination);
            // Everything but the archive URL is the author's signed data.
            assert_eq!(binary[platform]["executable_sha256"], "c".repeat(64));
        }
        assert_eq!(mirrored["package"]["tab"]["backend"]["protocol"], 1);
    }

    #[test]
    fn third_party_backend_archives_come_from_the_submitted_release() {
        for (field, url) in [
            (
                "repository",
                "https://github.com/other/port-monitor/releases/download/v1.2.0/b.tar.gz",
            ),
            (
                "tag",
                "https://github.com/acme/port-monitor/releases/download/v9.9.9/b.tar.gz",
            ),
        ] {
            let mut submission = backend_submission();
            submission["package"]["package"]["tab"]["distribution"]["binary"]["linux-x86_64"]
                ["archive"] = json!(url);
            assert!(validate_submission(&submission).is_err(), "{field}");
        }
        let mut wrong_tag = backend_submission();
        wrong_tag["source"]["tag"] = json!("v1.2.1");
        assert!(validate_submission(&wrong_tag).is_err());
    }

    #[test]
    fn tab_contract_rejects_ambiguous_kinds_versions_and_launch_fields() {
        for pointer in [
            "/package/tab/api_version",
            "/package/tab/id",
            "/package/host",
        ] {
            let mut value = package();
            *value.pointer_mut(pointer).unwrap() = Value::Null;
            assert!(parse_marketplace_package(&value).is_err());
        }
        for field in ["cmd", "args", "env", "targets"] {
            let mut value = package();
            value["package"]["tab"]["distribution"][field] = json!({});
            assert!(validate_marketplace_package(&value).is_err());
        }
        // `binary` is the closed per-platform backend schema, never a bare
        // launch field: it needs `backend` and complete entries.
        let mut value = package();
        value["package"]["tab"]["distribution"]["binary"] = json!({});
        assert!(validate_marketplace_package(&value).is_err());
        value["package"]["tab"]["backend"] = json!({"protocol":1,"reasoning":"Ports"});
        assert!(validate_marketplace_package(&value).is_err());
        value["package"]["tab"]["distribution"]["binary"] =
            json!({"linux-x86_64":{"cmd":"bin/backend"}});
        assert!(validate_marketplace_package(&value).is_err());
        let mut value = package();
        value["kind"] = json!("theme");
        assert!(validate_marketplace_package(&value).is_err());
    }
}
