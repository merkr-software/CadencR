//! Cold model discovery uses the account catalog without opening ACP sessions.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    Meta, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
};
use cadencr_provider_sdk::ProviderError;
use serde_json::json;

use crate::{cli, config};

// The host allows ten seconds for the whole discovery subcommand.
const MODELS_TIMEOUT: Duration = Duration::from_secs(8);
const MODEL_SIGN_IN: &str = "Error: Please sign in to view available models.";
const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

pub async fn discover(
    binary: &Path,
    cwd: &Path,
) -> Result<Vec<SessionConfigOption>, ProviderError> {
    let mut command = cli::command(binary);
    command.arg("models").current_dir(cwd).stdin(Stdio::null());
    let output = tokio::time::timeout(MODELS_TIMEOUT, command.output())
        .await
        .map_err(|_| ProviderError::new("`agy models` timed out."))?
        .map_err(|error| ProviderError::new(format!("Could not run `agy models`: {error}")))?;
    if !output.status.success() {
        let diagnostics = String::from_utf8_lossy(&output.stderr);
        if diagnostics
            .lines()
            .any(|line| line.trim_start().starts_with(MODEL_SIGN_IN))
        {
            return Err(ProviderError::authentication_required(cli::SIGN_IN));
        }
        return Err(ProviderError::new(format!(
            "`agy models` failed ({}). Run it in a terminal to see the CLI diagnostics.",
            output.status
        )));
    }

    let stdout = std::str::from_utf8(&output.stdout)
        .map_err(|_| ProviderError::new("`agy models` returned invalid UTF-8."))?;
    let models = parse(stdout);
    let current = models
        .first()
        .ok_or_else(|| ProviderError::new("`agy models` returned no models."))?
        .value
        .clone();
    let model = SessionConfigOption::select("model", "Model", current, models)
        .category(SessionConfigOptionCategory::Model);
    Ok(vec![model, serde_json::from_value(config::catalog_mode())?])
}

fn parse(stdout: &str) -> Vec<SessionConfigSelectOption> {
    let mut seen = HashSet::new();
    let rows: Vec<_> = stdout
        .lines()
        .filter_map(|line| line.trim().split_once('\t'))
        .filter(|(id, label)| {
            !id.is_empty()
                && !label.is_empty()
                && !id.chars().any(char::is_whitespace)
                && seen.insert(*id)
        })
        .map(|(id, label)| (id, label, thinking_variant(id, label)))
        .collect();

    // CLI IDs encode thinking level. ACP groups models with multiple levels
    // under their base IDs and exposes the valid levels in a separate option.
    // For a single published variant ACP keeps the ID and label as printed.
    let mut variants: HashMap<_, Vec<_>> = HashMap::new();
    for &(_, _, variant) in &rows {
        if let Some((base, _, effort)) = variant {
            variants.entry(base).or_default().push(effort);
        }
    }
    let mut selected = HashSet::new();
    rows.into_iter()
        .filter_map(|(id, label, variant)| {
            if let Some((base, name, _)) = variant {
                if let Some(efforts) = variants.get(base).filter(|efforts| efforts.len() > 1) {
                    return selected.insert(base).then(|| {
                        let levels: Vec<_> = EFFORT_LEVELS
                            .into_iter()
                            .filter(|level| efforts.contains(level))
                            .collect();
                        let metadata: Meta = [(
                            "cadencr".into(),
                            json!({
                                    "supportsEffort": true, "supportedEffortLevels": levels
                            }),
                        )]
                        .into_iter()
                        .collect();
                        SessionConfigSelectOption::new(base.to_owned(), name).meta(metadata)
                    });
                }
            }
            selected
                .insert(id)
                .then(|| SessionConfigSelectOption::new(id.to_owned(), label))
        })
        .collect()
}

fn thinking_variant<'a>(id: &'a str, label: &'a str) -> Option<(&'a str, &'a str, &'a str)> {
    let (base, level) = id.rsplit_once('-')?;
    let (name, shown_level) = label.strip_suffix(')')?.rsplit_once(" (")?;
    let same_level = shown_level.eq_ignore_ascii_case(level)
        || (level == "xhigh" && matches!(shown_level, "Extra" | "Extra High"));
    (EFFORT_LEVELS.contains(&level) && same_level && !base.is_empty() && !name.is_empty())
        .then_some((base, name, level))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_real_effort_variants_but_keeps_single_and_non_effort_ids() {
        let result = parse(concat!(
            "Fetching available models...\r\n",
            "neon-high\tGemini Neon (High)\r\n",
            "neon-high\tDuplicate (High)\n",
            "neon-xhigh\tGemini Neon (XHigh)\n",
            "neon-low\tGemini Neon (Low)\n",
            "orchestrator-neon\tOrchestrator (Neon)\n",
            "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n",
            "special-high\tSpecial model\n",
            "special-low\tSpecial model\n",
        ));
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!([
                {"value":"neon","name":"Gemini Neon","_meta":{"cadencr":{
                    "supportsEffort":true,"supportedEffortLevels":["low","high","xhigh"]
                }}},
                {"value":"orchestrator-neon","name":"Orchestrator (Neon)"},
                {"value":"gpt-oss-120b-medium","name":"GPT-OSS 120B (Medium)"},
                {"value":"special-high","name":"Special model"},
                {"value":"special-low","name":"Special model"}
            ])
        );
    }
}
