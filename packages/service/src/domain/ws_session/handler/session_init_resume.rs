use crate::domain::agents::runtime_adapter;

pub(super) fn resume_session_id_for_provider(
    provider_id: &str,
    row_runtime_provider: Option<&str>,
    runtime_session_id: Option<&str>,
) -> Option<String> {
    if row_runtime_provider.is_some() && row_runtime_provider != Some(provider_id) {
        return None;
    }
    let adapter = runtime_adapter(provider_id)?;
    adapter.resolve_resume_session_id(runtime_session_id)
}

#[cfg(test)]
mod tests {
    use super::resume_session_id_for_provider;
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
}
