//! The reserved official publisher identifier.
//!
//! `host.publisher` is not cryptographic: ownership comes from the package's
//! source repository. The official identifier is therefore only valid for
//! packages whose repository belongs to the official GitHub organisation.
//! Every validation path (submissions, contributions, catalog publication)
//! goes through [`reserved_publisher_error`] so the rule has one definition.

use serde_json::Value;

/// Publisher identifier reserved for official packages (compared
/// case-insensitively).
pub(crate) const RESERVED_PUBLISHER: &str = "cadencr";
/// GitHub organisation that owns every repository allowed to use
/// [`RESERVED_PUBLISHER`] (compared case-insensitively, like GitHub).
pub(crate) const OFFICIAL_OWNER: &str = "merkr-software";

fn is_official_repository(repository: &str) -> bool {
    crate::submission::canonical_github_repository(repository)
        && repository
            .strip_prefix("https://github.com/")
            .and_then(|rest| rest.split('/').next())
            .is_some_and(|owner| owner.eq_ignore_ascii_case(OFFICIAL_OWNER))
}

/// The diagnostic for a package claiming the reserved publisher from a
/// repository the official organisation does not own, or `None` when the
/// pair is allowed. `label` names the publisher field, e.g. `host.publisher`.
pub(crate) fn reserved_publisher_error(
    label: &str,
    publisher: Option<&str>,
    repository: Option<&str>,
) -> Option<String> {
    let publisher = publisher.filter(|p| p.eq_ignore_ascii_case(RESERVED_PUBLISHER))?;
    if repository.is_some_and(is_official_repository) {
        return None;
    }
    Some(format!(
        "{label} {publisher:?} is reserved for {OFFICIAL_OWNER} repositories"
    ))
}

/// [`reserved_publisher_error`] for a marketplace package (any kind, either
/// schema), against the author repository the package itself declares.
pub(crate) fn package_reserved_publisher_error(package: &Value, label: &str) -> Option<String> {
    package_reserved_publisher_error_for(
        package,
        crate::marketplace::descriptor(package).get("repository"),
        label,
    )
}

/// As [`package_reserved_publisher_error`], against an explicit repository
/// (a submission's `source.repository`).
pub(crate) fn package_reserved_publisher_error_for(
    package: &Value,
    repository: Option<&Value>,
    label: &str,
) -> Option<String> {
    reserved_publisher_error(
        label,
        crate::marketplace::body(package)
            .pointer("/host/publisher")
            .and_then(Value::as_str),
        repository.and_then(Value::as_str),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LABEL: &str = "host.publisher";

    fn error(publisher: &str, repository: &str) -> Option<String> {
        reserved_publisher_error(LABEL, Some(publisher), Some(repository))
    }

    #[test]
    fn official_repositories_may_use_the_reserved_publisher() {
        for repository in [
            "https://github.com/merkr-software/cadencr-pi",
            "https://github.com/Merkr-Software/CadencR",
        ] {
            assert_eq!(error("cadencr", repository), None, "{repository}");
        }
    }

    #[test]
    fn other_repositories_are_refused_in_any_publisher_case() {
        for publisher in ["cadencr", "Cadencr", "CADENCR"] {
            for repository in [
                "https://github.com/acme/provider",
                "https://github.com/merkr-software-evil/provider",
                "https://github.com/evil-merkr-software/provider",
                "https://github.com/merkr-software/provider/extra",
                "https://github.com/merkr-software",
                "https://user@github.com/merkr-software/provider",
                "https://github.com.evil.example/merkr-software/provider",
                "https://gitlab.com/merkr-software/provider",
                "http://github.com/merkr-software/provider",
                "merkr-software/provider",
            ] {
                assert_eq!(
                    error(publisher, repository),
                    Some(format!(
                        "host.publisher {publisher:?} is reserved for merkr-software repositories"
                    )),
                    "{publisher} {repository}"
                );
            }
        }
        assert!(reserved_publisher_error(LABEL, Some("cadencr"), None).is_some());
    }

    #[test]
    fn other_publishers_are_unaffected() {
        assert_eq!(error("acme", "https://github.com/acme/provider"), None);
        assert_eq!(
            error("cadencr-labs", "https://github.com/acme/provider"),
            None
        );
        assert_eq!(reserved_publisher_error(LABEL, None, None), None);
    }

    #[test]
    fn packages_are_checked_against_their_declared_repository() {
        let package = |publisher: &str, repository: &str| {
            json!({"kind":"theme","package":{"theme":{"repository":repository},
                "host":{"publisher":publisher}}})
        };
        assert_eq!(
            package_reserved_publisher_error(
                &package("cadencr", "https://github.com/merkr-software/themes"),
                LABEL
            ),
            None
        );
        assert!(package_reserved_publisher_error(
            &package("CadencR", "https://github.com/acme/themes"),
            LABEL
        )
        .is_some());
        let legacy = json!({"agent":{"repository":"https://github.com/acme/p"},
            "host":{"publisher":"cadencr"}});
        assert!(package_reserved_publisher_error(&legacy, LABEL).is_some());
    }
}
