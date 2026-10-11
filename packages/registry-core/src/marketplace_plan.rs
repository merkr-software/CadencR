use crate::RegistryError;
use serde_json::{json, Value};

pub(crate) fn create(submission: &Value, repository: &str) -> Result<Value, RegistryError> {
    let entry = &submission["package"];
    if crate::marketplace::kind(entry) == "provider" {
        let mut legacy = submission.clone();
        legacy["schema_version"] = json!(1);
        legacy["package"] = entry["package"].clone();
        let mut plan = crate::create_publication_plan(&legacy, repository)?;
        plan["schema_version"] = json!(2);
        plan["source"]["submission"] = submission.clone();
        plan["mirrored_package"] =
            json!({"kind":"provider","package":plan["mirrored_package"].clone()});
        return Ok(plan);
    }
    let (id, version) = crate::marketplace::marketplace_package_identity(entry)
        .ok_or_else(|| RegistryError::single("invalid theme identity"))?;
    let distribution = &entry["package"]["theme"]["distribution"];
    let source_url = distribution["archive"]
        .as_str()
        .ok_or_else(|| RegistryError::single("missing theme archive"))?;
    if !source_url.ends_with(".tar.gz") && !source_url.ends_with(".tgz") {
        return Err(RegistryError::single("themes require gzip tar archives"));
    }
    let tag = format!("theme-{id}-v{version}");
    let asset = "theme.tar.gz";
    let destination = format!("https://github.com/{repository}/releases/download/{tag}/{asset}");
    let mut mirrored = entry.clone();
    mirrored["package"]["theme"]["distribution"]["archive"] = json!(destination);
    Ok(json!({
        "schema_version":2,"repository":repository,
        "source":{"submission":submission,"identity":{"provider_id":id,"version":version,
            "repository":submission["source"]["repository"],"commit":submission["source"]["commit"],"tag":submission["source"]["tag"]}},
        "release":{"tag":tag},
        "targets":[{"target":"theme","asset":asset,"source_url":source_url,"destination_url":destination,"sha256":distribution["sha256"]}],
        "mirrored_package":mirrored
    }))
}
