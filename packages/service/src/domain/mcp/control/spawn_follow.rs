use serde::{Deserialize, Serialize};

use super::spawn_session::SpawnSessionRequest;

#[derive(Debug, Deserialize)]
pub(super) struct SpawnFollowOptions {
    gates: Option<bool>,
    completion: Option<bool>,
}

impl SpawnFollowOptions {
    /// Neither the child's gates nor its completion reach the parent agent.
    pub(super) fn detached() -> Self {
        Self {
            gates: Some(false),
            completion: Some(false),
        }
    }
}

impl SpawnSessionRequest {
    pub(super) fn follows_gates(&self) -> bool {
        self.follow
            .as_ref()
            .map(|follow| follow.gates.unwrap_or(true))
            .unwrap_or_else(|| self.link_to_current_session.unwrap_or(true))
    }

    pub(super) fn follows_completion(&self) -> bool {
        self.follow
            .as_ref()
            .map(|follow| follow.completion.unwrap_or(true))
            .unwrap_or_else(|| self.await_result.unwrap_or(false))
    }
}

#[derive(Debug, Serialize)]
pub(super) struct SpawnFollowResponse {
    gates: bool,
    completion: bool,
    delivery: &'static str,
    #[serde(rename = "pollingRequired")]
    polling_required: bool,
}

impl SpawnFollowResponse {
    pub(super) fn from_request(request: &SpawnSessionRequest) -> Self {
        Self {
            gates: request.follows_gates(),
            completion: request.follows_completion(),
            delivery: "steer_current_turn",
            polling_required: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(extra: serde_json::Value) -> SpawnSessionRequest {
        let mut value = serde_json::json!({
            "source_feature_id": 1,
            "source_session_id": 2
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().expect("extra spawn fields").clone());
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn follow_enables_reactive_gates_and_completion_by_default() {
        let request = request(serde_json::json!({ "follow": {} }));
        assert!(request.follows_gates());
        assert!(request.follows_completion());
    }

    #[test]
    fn legacy_spawn_defaults_to_gate_following_only() {
        let request = request(serde_json::json!({}));
        assert!(request.follows_gates());
        assert!(!request.follows_completion());
    }

    #[test]
    fn follow_fields_are_explicit_opt_outs() {
        let request = request(serde_json::json!({
            "follow": { "gates": false, "completion": false }
        }));
        assert!(!request.follows_gates());
        assert!(!request.follows_completion());
    }
}
