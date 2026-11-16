//! The auto-naming prompt pair: a user-editable system prompt (workspace
//! setting, falling back to the built-in default) and the fixed per-request
//! user message that carries the delimiter contract `extract_name` parses.

use crate::domain::settings_store;

/// Workspace setting holding the user's custom auto-naming system prompt. An
/// empty or whitespace-only value means "use the built-in default".
const AUTO_NAME_SYSTEM_PROMPT_KEY: &str = "auto_name_system_prompt";

pub const DEFAULT_AUTO_NAME_SYSTEM_PROMPT: &str = "You are a feature naming assistant. Your ONLY job is to output a short name (3-7 words) for a coding session. ALWAYS output a name, even if the input is vague — just pick a reasonable generic name. Examples: 'hi' → 'General Coding Session', 'fix the login bug' → 'Fix Login Bug', 'I want to add dark mode' → 'Add Dark Mode Support'.";

/// Opening of every naming request. Importers match it to recognise (and skip)
/// Cadencr's own naming sessions — the system prompt is user-editable, so it
/// cannot serve as that marker.
pub const AUTO_NAME_USER_PROMPT_PREFIX: &str = "Now name this session. User's first message:";

/// Delimiters the model is asked to wrap the name in; `extract_name` parses them.
pub(super) const NAME_START: &str = "__FEATURE_NAME_START__";
pub(super) const NAME_END: &str = "__FEATURE_NAME_END__";

/// The system prompt the next naming spawn uses: the user's custom prompt when
/// set, otherwise the built-in default.
pub fn resolve_system_prompt() -> String {
    settings_store::global_get_nonempty(AUTO_NAME_SYSTEM_PROMPT_KEY)
        .unwrap_or_else(|| DEFAULT_AUTO_NAME_SYSTEM_PROMPT.to_string())
}

/// The delimiter instruction lives here, not in the system prompt, so a custom
/// system prompt can never break name extraction.
///
/// The naming instructions ride inside the user prompt: ACP-installed
/// providers drop `RuntimeSpawnConfig::system_prompt` on the floor (the ACP
/// `session/new` request has no field for it), so relying on the system slot
/// would silently run the naming with no instructions on those providers. The
/// importer marker stays first so `codex_rollout` keeps recognising naming
/// sessions.
pub fn build_prompt(user_input: &str, system_prompt: &str) -> String {
    let escaped_input = user_input.replace('"', "\\\"");
    format!(
        "{AUTO_NAME_USER_PROMPT_PREFIX} \"{escaped_input}\". {system_prompt} Reply with ONLY: {NAME_START}<name>{NAME_END}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prompt_escapes_quotes() {
        let prompt = build_prompt("say \"hi\"", DEFAULT_AUTO_NAME_SYSTEM_PROMPT);
        assert!(prompt.contains("\\\"hi\\\""));
        assert!(prompt.contains(NAME_START));
    }

    #[tokio::test]
    async fn resolve_system_prompt_defaults_when_unset_or_blank() {
        assert_eq!(resolve_system_prompt(), DEFAULT_AUTO_NAME_SYSTEM_PROMPT);
        settings_store::global_set(AUTO_NAME_SYSTEM_PROMPT_KEY, "  \n ")
            .await
            .unwrap();
        assert_eq!(resolve_system_prompt(), DEFAULT_AUTO_NAME_SYSTEM_PROMPT);
    }

    #[tokio::test]
    async fn resolve_system_prompt_prefers_the_custom_prompt() {
        settings_store::global_set(AUTO_NAME_SYSTEM_PROMPT_KEY, "Name in French.")
            .await
            .unwrap();
        assert_eq!(resolve_system_prompt(), "Name in French.");
    }

    #[test]
    fn build_prompt_opens_with_the_importer_marker() {
        assert!(build_prompt("fix it", DEFAULT_AUTO_NAME_SYSTEM_PROMPT)
            .starts_with(AUTO_NAME_USER_PROMPT_PREFIX));
    }

    #[test]
    fn build_prompt_inlines_the_system_prompt() {
        let prompt = build_prompt("fix it", "Name in French.");
        assert!(prompt.contains("Name in French."));
        assert!(prompt.starts_with(AUTO_NAME_USER_PROMPT_PREFIX));
    }
}
