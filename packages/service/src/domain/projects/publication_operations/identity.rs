use super::PublicationOperationKind;
use crate::error::AppError;
use sha2::{Digest as _, Sha256};

#[bon::builder]
pub fn operation_id(
    project_id: i64,
    kind: PublicationOperationKind,
    bundle_id: &str,
    bundle_ids: &[String],
    release_notes: &str,
    plan_sha256: &str,
) -> Result<String, AppError> {
    if !valid_id(plan_sha256) {
        return Err(AppError::BadRequest(
            "publication plan SHA-256 must be exact lowercase hex".into(),
        ));
    }
    let mut bundles = bundle_ids.to_vec();
    bundles.push(bundle_id.into());
    bundles.sort();
    bundles.dedup();
    let binding = serde_json::json!({"schema_version":1,"project_id":project_id,"kind":kind,
        "bundle_id":bundle_id,"bundle_ids":bundles,"release_notes":release_notes,"plan_sha256":plan_sha256,"confirmed":true});
    let bytes = cadencr_registry_core::canonical_json_bytes(&binding);
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_bind_project_kind_plan_notes_and_bundles_but_not_order() {
        let id = |project, kind, notes: &str, bundles: &[String]| {
            operation_id()
                .project_id(project)
                .kind(kind)
                .bundle_id("first")
                .bundle_ids(bundles)
                .release_notes(notes)
                .plan_sha256(&"a".repeat(64))
                .call()
                .unwrap()
        };
        let original = id(
            1,
            PublicationOperationKind::Release,
            "notes",
            &["a".into(), "b".into()],
        );
        assert_eq!(
            original,
            id(
                1,
                PublicationOperationKind::Release,
                "notes",
                &["b".into(), "a".into()]
            )
        );
        assert_ne!(
            original,
            id(
                2,
                PublicationOperationKind::Release,
                "notes",
                &["a".into(), "b".into()]
            )
        );
        assert_ne!(
            original,
            id(
                1,
                PublicationOperationKind::Registry,
                "notes",
                &["a".into(), "b".into()]
            )
        );
        assert_ne!(
            original,
            id(
                1,
                PublicationOperationKind::Release,
                "changed",
                &["a".into(), "b".into()]
            )
        );
    }
}
