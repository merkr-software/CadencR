const OPENCODE_MODEL_PROVIDER_PREFIXES: &[&str] = &[
    "anthropic",
    "azure",
    "bedrock",
    "cerebras",
    "cohere",
    "deepseek",
    "default",
    "fireworks",
    "google",
    "groq",
    "github-copilot",
    "mistral",
    "moonshot",
    "ollama",
    "openai",
    "openrouter",
    "perplexity",
    "replicate",
    "sambanova",
    "together",
    "vertex",
    "xai",
];

/// Parse provider-scoped model refs understood by OpenCode.
pub fn parse_opencode_model_ref(model: &str) -> Option<(&str, &str)> {
    let trimmed = model.trim();
    let (provider_id, model_id) = trimmed.split_once('/')?;

    (!model_id.is_empty() && OPENCODE_MODEL_PROVIDER_PREFIXES.contains(&provider_id))
        .then_some((provider_id, model_id))
}

#[cfg(test)]
mod tests {
    use super::parse_opencode_model_ref;

    #[test]
    fn detects_provider_scoped_opencode_models() {
        assert_eq!(
            parse_opencode_model_ref("openai/gpt-5.4"),
            Some(("openai", "gpt-5.4"))
        );
        assert!(parse_opencode_model_ref("anthropic/claude-sonnet-4-5").is_some());
        assert!(parse_opencode_model_ref("github-copilot/claude-opus-4.6").is_some());
        assert!(parse_opencode_model_ref("default/default").is_some());
    }

    #[test]
    fn rejects_plain_and_unknown_model_refs() {
        assert!(parse_opencode_model_ref("opus").is_none());
        assert!(parse_opencode_model_ref("claude-opus-4-6").is_none());
        assert!(parse_opencode_model_ref("folder/model").is_none());
        assert!(parse_opencode_model_ref("openai/").is_none());
    }
}
