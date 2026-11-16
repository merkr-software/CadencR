use super::Release;
use crate::PublisherError;

/// Only a release whose immutable publication binding was checked may use draft URLs.
#[derive(Clone, Copy, Default)]
pub(crate) struct AssetUrlPolicy {
    draft: bool,
}

#[bon::bon]
impl AssetUrlPolicy {
    #[builder]
    pub(crate) fn bound_draft(
        release: &Release,
        tag: &str,
        commit: &str,
        body: &str,
    ) -> Result<Self, PublisherError> {
        crate::mirror::release::validate_bound_release(release, tag, commit, body)?;
        if !release.draft {
            return Err(PublisherError::new("release is not a bound draft"));
        }
        Ok(Self { draft: true })
    }

    pub(crate) fn matches(self, actual: &str, expected: &str) -> bool {
        if actual == expected {
            return true;
        }
        if !self.draft {
            return false;
        }
        let raw_actual = actual;
        let (Ok(actual), Ok(expected)) = (url::Url::parse(actual), url::Url::parse(expected))
        else {
            return false;
        };
        if actual.as_str() != raw_actual
            || actual.scheme() != "https"
            || actual.host_str() != Some("github.com")
            || actual.origin() != expected.origin()
            || !actual.username().is_empty()
            || actual.password().is_some()
            || actual.query().is_some()
            || actual.fragment().is_some()
        {
            return false;
        }
        let actual: Vec<_> = actual.path().split('/').collect();
        let expected: Vec<_> = expected.path().split('/').collect();
        actual.len() == 7
            && expected.len() == 7
            && actual[..5] == expected[..5]
            && actual[3..5] == ["releases", "download"]
            && actual[6] == expected[6]
            && actual[5].strip_prefix("untagged-").is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FINAL: &str =
        "https://github.com/cadencr/registry/releases/download/theme-v1/theme.tar.gz";
    const DRAFT: &str = "https://github.com/cadencr/registry/releases/download/untagged-25ed19a6fe3094df27fd/theme.tar.gz";

    fn release() -> Release {
        Release {
            id: 7,
            draft: true,
            prerelease: false,
            tag_name: "theme-v1".into(),
            target_commitish: "a".repeat(40),
            body: "bound".into(),
        }
    }

    #[test]
    fn only_bound_drafts_accept_safe_untagged_urls() {
        let release = release();
        let policy = AssetUrlPolicy::bound_draft()
            .release(&release)
            .tag("theme-v1")
            .commit(&"a".repeat(40))
            .body("bound")
            .call()
            .unwrap();
        assert!(policy.matches(DRAFT, FINAL));
        assert!(policy.matches(FINAL, FINAL));
        assert!(!AssetUrlPolicy::default().matches(DRAFT, FINAL));
        for invalid in [
            DRAFT.replace("cadencr/registry", "foreign/registry"),
            DRAFT.replace("theme.tar.gz", "other.tar.gz"),
            format!("{DRAFT}?download=1"),
            format!("{DRAFT}#fragment"),
            DRAFT.replace("https:", "http:"),
            DRAFT.replace("github.com", "github.com.evil"),
            DRAFT.replace("untagged-25ed19a6fe3094df27fd", "other-tag"),
            DRAFT.replace("untagged-25ed19a6fe3094df27fd", "untagged-"),
            DRAFT.replace("untagged-25ed19a6fe3094df27fd", "untagged-%2Fbad"),
            DRAFT.replace("github.com", "user@github.com"),
        ] {
            assert!(!policy.matches(&invalid, FINAL), "{invalid}");
        }
        {
            let mut invalid = release.clone();
            invalid.draft = false;
            assert!(AssetUrlPolicy::bound_draft()
                .release(&invalid)
                .tag("theme-v1")
                .commit(&"a".repeat(40))
                .body("bound")
                .call()
                .is_err());
        }
        assert!(AssetUrlPolicy::bound_draft()
            .release(&release)
            .tag("wrong")
            .commit(&"a".repeat(40))
            .body("bound")
            .call()
            .is_err());
        assert!(AssetUrlPolicy::bound_draft()
            .release(&release)
            .tag("theme-v1")
            .commit(&"b".repeat(40))
            .body("bound")
            .call()
            .is_err());
        assert!(AssetUrlPolicy::bound_draft()
            .release(&release)
            .tag("theme-v1")
            .commit(&"a".repeat(40))
            .body("wrong")
            .call()
            .is_err());
    }
    #[test]
    fn draft_metadata_is_not_published_proof_and_size_state_remain_exact() {
        use crate::github::Asset;
        use crate::mirror::artifacts::{
            validated_metadata, validated_metadata_with_policy, AssetMetadata,
        };
        let release = release();
        let policy = AssetUrlPolicy::bound_draft()
            .release(&release)
            .tag("theme-v1")
            .commit(&"a".repeat(40))
            .body("bound")
            .call()
            .unwrap();
        let expected = [AssetMetadata {
            name: "theme.tar.gz",
            size: Some(1100),
            expected_url: FINAL,
        }];
        let asset = Asset {
            id: 642988641,
            name: "theme.tar.gz".into(),
            size: 1100,
            state: "uploaded".into(),
            browser_download_url: DRAFT.into(),
        };
        assert!(
            validated_metadata_with_policy(vec![asset.clone()], &expected, true, policy).is_ok()
        );
        assert!(validated_metadata(vec![asset.clone()], &expected, true).is_err());
        let mut wrong_size = asset.clone();
        wrong_size.size += 1;
        assert!(validated_metadata_with_policy(vec![wrong_size], &expected, true, policy).is_err());
        let mut not_uploaded = asset;
        not_uploaded.state = "new".into();
        assert!(
            validated_metadata_with_policy(vec![not_uploaded], &expected, true, policy).is_err()
        );
    }
}
