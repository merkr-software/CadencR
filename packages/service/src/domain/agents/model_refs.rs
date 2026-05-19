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

/// Provider-scoped model refs like `openai/gpt-5.4` are routed through OpenCode.
/// Plain Claude Code model ids stay on the default runtime.
pub fn is_opencode_model_ref(model: &str) -> bool {
    let trimmed = model.trim();
    let Some((provider_id, model_id)) = trimmed.split_once('/') else {
        return false;
    };

    !model_id.is_empty() && OPENCODE_MODEL_PROVIDER_PREFIXES.contains(&provider_id)
}

#[cfg(test)]
mod tests {
    use super::is_opencode_model_ref;

    #[test]
    fn detects_provider_scoped_opencode_models() {
        assert!(is_opencode_model_ref("openai/gpt-5.4"));
        assert!(is_opencode_model_ref("anthropic/claude-sonnet-4-5"));
        assert!(is_opencode_model_ref("github-copilot/claude-opus-4.6"));
        assert!(is_opencode_model_ref("default/default"));
    }

    #[test]
    fn rejects_plain_and_unknown_model_refs() {
        assert!(!is_opencode_model_ref("opus"));
        assert!(!is_opencode_model_ref("claude-opus-4-6"));
        assert!(!is_opencode_model_ref("folder/model"));
        assert!(!is_opencode_model_ref("openai/"));
    }
}
