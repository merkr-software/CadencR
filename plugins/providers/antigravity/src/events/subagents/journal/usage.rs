//! Per-generation accounting in one verified child's transcript. agy reports
//! uncached input and cache reads separately (cache reads can exceed input).
use agent_client_protocol::schema::v1::Meta;
use cadencr_provider_sdk::meta::{subagent_update_meta, SubagentStatus};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct ChildUsage {
    model: Option<(u64, String)>,
    by_step: HashMap<u64, u128>,
    total: u128,
}

impl ChildUsage {
    pub(super) fn observe(&mut self, step: &Value) -> bool {
        if step["source"] != "MODEL" || step["type"] != "PLANNER_RESPONSE" {
            return false;
        }
        let Some(index) = step["step_index"].as_u64() else {
            return false;
        };
        let mut changed = false;
        if let Some(model) = step["model"].as_str().filter(|s| !s.trim().is_empty()) {
            match &mut self.model {
                Some((last_index, last_model)) if index >= *last_index && last_model == model => {
                    *last_index = index;
                }
                Some((last_index, _)) if index < *last_index => {}
                _ => {
                    self.model = Some((index, model.to_owned()));
                    changed = true;
                }
            }
        }
        if let (Some(input), Some(output)) = (
            step["input_tokens"].as_u64(),
            step["output_tokens"].as_u64(),
        ) {
            let cached = step["cache_read_tokens"].as_u64().unwrap_or(0);
            let amount = u128::from(input) + u128::from(cached) + u128::from(output);
            // Snapshots can be replayed or revised under the same step index.
            let old = self.by_step.insert(index, amount);
            self.total = self.total - old.unwrap_or(0) + amount;
            changed |= old != Some(amount);
        }
        changed
    }

    pub(super) fn metadata(&self, status: Option<SubagentStatus>, summary: Option<&str>) -> Meta {
        subagent_update_meta()
            .maybe_status(status)
            .maybe_summary(summary)
            .maybe_resolved_model(self.model.as_ref().map(|(_, model)| model.as_str()))
            .maybe_total_tokens(
                (!self.by_step.is_empty()).then(|| u64::try_from(self.total).unwrap_or(u64::MAX)),
            )
            .call()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_each_generation_once_and_retains_the_latest_reported_model() {
        let mut child = ChildUsage::default();
        let mut row = json!({"source":"MODEL","type":"PLANNER_RESPONSE","step_index":1,
            "model":"first","input_tokens":2,"cache_read_tokens":9,"output_tokens":3});
        assert!(child.observe(&row));
        assert!(!child.observe(&row));
        row["step_index"] = json!(3);
        row["model"] = json!("second");
        assert!(child.observe(&row));
        row["step_index"] = json!(1);
        row["model"] = json!("first");
        row["output_tokens"] = json!(4);
        assert!(child.observe(&row));
        let meta = child.metadata(None, None);
        let fields = &meta["cadencr"]["subagent"];
        assert_eq!(fields, &json!({"totalTokens":29,"resolvedModel":"second"}));
        assert!(
            !child.observe(&json!({"source":"USER","type":"PLANNER_RESPONSE","model":"ignore"}))
        );
    }
}
