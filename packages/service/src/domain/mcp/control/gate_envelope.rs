use super::reply_envelope::escape_xml_attribute;

pub(super) struct GateEnvelopeMetadata<'a> {
    pub child_session_id: i64,
    pub child_feature_id: i64,
    pub child_feature_title: &'a str,
    pub child_project_id: i64,
    pub kind: &'a str,
    pub request_id: &'a str,
}

pub(super) fn build_gate_envelope(
    metadata: GateEnvelopeMetadata<'_>,
    payload: &serde_json::Value,
) -> Result<String, serde_json::Error> {
    let body = serde_json::to_string_pretty(payload)?;
    Ok(format!(
        "<cadencr-gate from-session=\"{}\" from-feature=\"{}\" from-feature-title=\"{}\" from-project=\"{}\" kind=\"{}\" request-id=\"{}\">\n{}\n</cadencr-gate>",
        metadata.child_session_id,
        metadata.child_feature_id,
        escape_xml_attribute(metadata.child_feature_title),
        metadata.child_project_id,
        metadata.kind,
        escape_xml_attribute(metadata.request_id),
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_envelope_carries_request_and_options() {
        let payload = serde_json::json!({
            "request_id": "req-7",
            "options": [{"decision": "allow_once", "label": "Allow once"}]
        });
        let text = build_gate_envelope(
            GateEnvelopeMetadata {
                child_session_id: 7,
                child_feature_id: 8,
                child_feature_title: "Child",
                child_project_id: 9,
                kind: "permission",
                request_id: "req-7",
            },
            &payload,
        )
        .unwrap();
        assert!(text.contains("request-id=\"req-7\""));
        assert!(text.contains("Allow once"));
    }
}
