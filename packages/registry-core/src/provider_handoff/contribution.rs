use std::path::Path;

use super::{bad, validate_records, ProviderHandoff};
use crate::{tree::Tree, RegistryError};

const FILE: &str = "provider-handoffs.json";

fn load(root: &Path) -> Result<Vec<ProviderHandoff>, RegistryError> {
    let path = root.join(FILE);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(bad(format!("cannot inspect {FILE}: {e}"))),
        Ok(_) => {}
    }
    read_file(&path)
}

pub fn read_file(path: &Path) -> Result<Vec<ProviderHandoff>, RegistryError> {
    let bytes = crate::safe_io::read_bounded_regular(path, 1024 * 1024)
        .map_err(|e| bad(format!("cannot read {FILE}: {e}")))?;
    let value = crate::parse_json_bytes(&bytes).map_err(|e| bad(e.to_string()))?;
    let records: Vec<ProviderHandoff> =
        serde_json::from_value(value).map_err(|e| bad(format!("invalid {FILE}: {e}")))?;
    validate_records(&records)?;
    Ok(records)
}

pub(crate) fn prepare(
    base_root: &Path,
    candidate_root: &Path,
    base: &Tree,
    candidate: &Tree,
    administrative: bool,
) -> Result<Vec<ProviderHandoff>, RegistryError> {
    let before = load(base_root)?;
    let after = load(candidate_root)?;
    if !after.starts_with(&before) {
        return Err(bad("provider handoff records are append-only"));
    }
    if before != after && !administrative {
        return Err(bad(
            "provider handoff changes require explicit administrative validation",
        ));
    }
    for record in &after {
        // Every retired version stays present, with its original owner. Author
        // URLs differ from registry mirrors; protected signing checks the exact
        // signed-catalog digests separately, against the authenticated baseline.
        for version in record.retired_versions.keys() {
            let name = format!("{}-{version}.json", record.provider_id);
            let package = candidate
                .packages
                .get(&name)
                .ok_or_else(|| bad("handoff cannot delete accepted package history"))?;
            record.check_package(package, false)?;
        }
        for package in crate::plugin_package::identity_units_of(candidate.packages.values()) {
            record.check_package(package, false)?;
        }
    }
    for record in &after[before.len()..] {
        let prior: Vec<_> = base
            .packages
            .values()
            .filter(|p| crate::package::identity(p).is_some_and(|(id, _)| id == record.provider_id))
            .collect();
        if prior.is_empty()
            || prior.len() != record.retired_versions.len()
            || prior.iter().any(|p| !record.retires(p))
        {
            return Err(bad(
                "handoff must retire all accepted versions of an existing provider",
            ));
        }
    }
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn write(root: &Path, name: &str, value: &Value) {
        let path = root.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    #[test]
    fn administrative_review_never_relaxes_accepted_files_or_ordinary_ownership() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let candidate = root.path().join("candidate");
        let package = |version: &str, publisher: &str| {
            json!({
            "agent":{"id":"pi","name":"Pi","version":version,"description":"Provider",
                "repository":format!("https://github.com/{publisher}/pi"),"license":"MIT",
                "distribution":{"binary":{"linux-x86_64":{"cmd":"bin/provider","sha256":"a".repeat(64),
                    "archive":format!("https://github.com/{publisher}/pi/releases/download/v{version}/provider.tar.gz")}}}},
            "host":{"publisher":publisher,"compatibility":{"min_app_version":"0.16.0"},
                "assets":{"icon":"icon.svg","readme":"README.md","license":"LICENSE"}}})
        };
        let old = package("0.4.1", "original");
        for dir in [&base, &candidate] {
            write(dir, "packages/pi-0.4.1.json", &old);
        }
        let next = package("0.5.0", "edjubert");
        write(&candidate, "packages/pi-0.5.0.json", &next);
        write(
            &candidate,
            "submissions/pi-0.5.0.json",
            &json!({"schema_version":1,
            "package":next,"source":{"repository":"https://github.com/edjubert/pi",
                "commit":"b".repeat(40),"tag":"v0.5.0"},"changelog":"Independent successor"}),
        );
        assert!(crate::validate_contribution(&base, &candidate).is_err());
        let records = json!([{"provider_id":"pi",
            "from":{"publisher":"original","repository":"https://github.com/original/pi"},
            "to":{"publisher":"edjubert","repository":"https://github.com/edjubert/pi"},
            "retired_versions":{"0.4.1":"a".repeat(64)},
            "authorization":"https://github.com/owner/registry/pull/22#issuecomment-1","reason":"Retire and transfer"}]);
        write(&candidate, FILE, &records);
        assert!(crate::validate_contribution(&base, &candidate)
            .unwrap_err()
            .to_string()
            .contains("administrative"));
        crate::validate_administrative_contribution(&base, &candidate).unwrap();
        // Once separately accepted in the trusted base, the successor is an ordinary version PR.
        write(&base, FILE, &records);
        crate::validate_contribution(&base, &candidate).unwrap();
        std::fs::remove_file(candidate.join("packages/pi-0.4.1.json")).unwrap();
        assert!(crate::validate_administrative_contribution(&base, &candidate).is_err());
        let mut mutated = old.clone();
        mutated["agent"]["description"] = json!("Changed history");
        write(&candidate, "packages/pi-0.4.1.json", &mutated);
        assert!(
            crate::validate_administrative_contribution(&base, &candidate)
                .unwrap_err()
                .to_string()
                .contains("immutable")
        );
    }
}
