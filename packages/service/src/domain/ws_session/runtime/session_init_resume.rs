use crate::domain::agents::runtime_adapter;

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

pub(in crate::domain::ws_session) fn resume_session_id_for_provider(
    provider_id: &str,
    row_runtime_provider: Option<&str>,
    runtime_session_id: Option<&str>,
) -> Option<String> {
    if row_runtime_provider.is_some() && row_runtime_provider != Some(provider_id) {
        return None;
    }
    runtime_adapter(provider_id)?.resolve_resume_session_id(runtime_session_id)
}

#[cfg(test)]
mod tests {
    use super::{persistable_resume_session_id_for_provider, resume_session_id_for_provider};
    use crate::domain::agents::runtime::DEFAULT_PROVIDER;

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
