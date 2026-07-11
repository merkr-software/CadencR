pub(super) struct ReplyEnvelopeMetadata<'a> {
    pub responder_session_id: i64,
    pub responder_feature_id: i64,
    pub responder_feature_title: &'a str,
    pub responder_project_id: i64,
    pub request_message_id: Option<i64>,
    pub link: &'a str,
    pub status: &'a str,
}

pub(super) fn build_reply_envelope(metadata: ReplyEnvelopeMetadata<'_>, body: &str) -> String {
    let request_id = metadata
        .request_message_id
        .map(|id| id.to_string())
        .unwrap_or_default();
    let feature_title = escape_xml_attribute(metadata.responder_feature_title);
    format!(
        "<cadencr-reply from-session=\"{}\" from-feature=\"{}\" from-feature-title=\"{}\" from-project=\"{}\" status=\"{}\" link=\"{}\" request-message-id=\"{}\">\n{}\n</cadencr-reply>",
        metadata.responder_session_id,
        metadata.responder_feature_id,
        feature_title,
        metadata.responder_project_id,
        metadata.status,
        metadata.link,
        request_id,
        body
    )
}

pub(super) fn escape_xml_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::escape_xml_attribute;

    #[test]
    fn feature_titles_are_safe_inside_reply_envelope_attributes() {
        assert_eq!(escape_xml_attribute("A & \"B\""), "A &amp; &quot;B&quot;");
    }
}
