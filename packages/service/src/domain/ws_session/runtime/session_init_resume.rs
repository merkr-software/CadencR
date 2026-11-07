use crate::domain::agents::runtime_adapter;

#[bon::builder]
pub(in crate::domain::ws_session) fn checked_resume_session_id(
    adapter: &dyn crate::domain::agents::adapter::AgentRuntimeAdapter,
    provider_id: &str,
    row_runtime_provider: Option<&str>,
    runtime_session_id: Option<&str>,
) -> Result<Option<String>, String> {
    if row_runtime_provider.is_some_and(|stored| stored != provider_id) {
        return Ok(None);
    }
    if let Some(reason) =
        runtime_session_id.and_then(|saved| adapter.resume_session_rejection(saved))
    {
        return Err(reason);
    }
    Ok(adapter.resolve_resume_session_id(runtime_session_id))
}

pub(in crate::domain::ws_session) fn persistable_resume_session_id_for_provider(
    provider_id: &str,
    runtime_session_id: Option<&str>,
    runtime_allows_persistence: bool,
) -> Option<String> {
    if !runtime_allows_persistence {
        return None;
    }
    runtime_adapter(provider_id)?.persistable_resume_session_id(runtime_session_id)
}

#[cfg(test)]
mod tests {
    use super::persistable_resume_session_id_for_provider;
    use crate::domain::agents::runtime::DEFAULT_PROVIDER;

    fn resume_session_id_for_provider(
        provider_id: &str,
        row_runtime_provider: Option<&str>,
        runtime_session_id: Option<&str>,
    ) -> Option<String> {
        let adapter = super::runtime_adapter(provider_id)?;
        super::checked_resume_session_id()
            .adapter(&*adapter)
            .provider_id(provider_id)
            .maybe_row_runtime_provider(row_runtime_provider)
            .maybe_runtime_session_id(runtime_session_id)
            .call()
            .unwrap()
    }

    struct OwnerAdapter;
    #[async_trait::async_trait]
    impl crate::domain::agents::adapter::AgentRuntimeAdapter for OwnerAdapter {
        fn catalog_entry(&self) -> crate::domain::agents::runtime::ProviderCatalogEntry {
            unreachable!("resume validation must not inspect the catalog")
        }
        fn resume_session_rejection(&self, saved: &str) -> Option<String> {
            (!saved.starts_with("bound:")).then(|| "MANAGED_SESSION_OWNER_CHANGED".into())
        }
        fn resolve_resume_session_id(&self, saved: Option<&str>) -> Option<String> {
            saved
                .filter(|saved| saved.starts_with("bound:"))
                .map(str::to_owned)
        }
        async fn spawn(
            &self,
            _: serde_json::Value,
            _: crate::domain::agents::adapter::RuntimeSpawnConfig,
        ) -> Result<
            Box<dyn crate::domain::agents::adapter::AgentRuntimeSession>,
            crate::domain::agents::adapter::RuntimeError,
        > {
            panic!("resume validation must reject before spawning")
        }
    }

    #[test]
    fn rejected_saved_owner_never_becomes_a_fresh_session_for_init_or_compact() {
        let resolve = |provider, saved| {
            super::checked_resume_session_id()
                .adapter(&OwnerAdapter)
                .provider_id("managed")
                .maybe_row_runtime_provider(provider)
                .maybe_runtime_session_id(saved)
                .call()
        };
        assert_eq!(
            resolve(Some("managed"), Some("foreign-native")).unwrap_err(),
            "MANAGED_SESSION_OWNER_CHANGED"
        );
        assert_eq!(
            resolve(Some("managed"), Some("bound:native")).unwrap(),
            Some("bound:native".into())
        );
        assert_eq!(
            resolve(Some("other"), Some("foreign-native")).unwrap(),
            None
        );
        assert_eq!(resolve(None, None).unwrap(), None);
    }

    #[test]
    fn resume_session_for_claude_rejects_non_uuid() {
        let resume = resume_session_id_for_provider(
            DEFAULT_PROVIDER,
            Some(DEFAULT_PROVIDER),
            Some("ses_27f586910ffeUNaKL2l5UARerl"),
        );
        assert_eq!(resume, None);
    }

    #[test]
    fn resume_session_for_claude_accepts_uuid() {
        let sid = "11111111-1111-4111-8111-111111111111";
        let resume =
            resume_session_id_for_provider(DEFAULT_PROVIDER, Some(DEFAULT_PROVIDER), Some(sid));
        assert_eq!(resume, Some(sid.to_string()));
    }

    #[test]
    fn resume_session_for_unknown_persisted_provider_accepts_adapter_valid_id() {
        let sid = "11111111-1111-4111-8111-111111111111";
        let resume = resume_session_id_for_provider(DEFAULT_PROVIDER, None, Some(sid));
        assert_eq!(resume, Some(sid.to_string()));
    }

    #[test]
    fn resume_session_for_opencode_acp_accepts_matching_runtime_id() {
        let opencode_sid = "ses_27f586910ffeUNaKL2l5UARerl";
        let matching =
            resume_session_id_for_provider("opencode", Some("opencode"), Some(opencode_sid));
        assert_eq!(matching, Some(opencode_sid.to_string()));

        let mismatched =
            resume_session_id_for_provider("claude_code", Some("opencode"), Some(opencode_sid));
        assert_eq!(mismatched, None);
    }

    #[test]
    fn persistence_respects_live_session_eligibility_without_changing_builtin_validation() {
        let sid = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            persistable_resume_session_id_for_provider(DEFAULT_PROVIDER, Some(sid), true),
            Some(sid.to_string())
        );
        assert_eq!(
            persistable_resume_session_id_for_provider(DEFAULT_PROVIDER, Some(sid), false),
            None
        );
        assert_eq!(
            persistable_resume_session_id_for_provider(DEFAULT_PROVIDER, Some("not-a-uuid"), true),
            None
        );
    }
}
