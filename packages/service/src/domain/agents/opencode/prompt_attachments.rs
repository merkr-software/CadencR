use crate::domain::agents::adapter::{
    decode_prompt_attachment_text as decode_text, RuntimePromptAttachment,
};
pub(super) fn attachment_block(attachment: &RuntimePromptAttachment<'_>) -> serde_json::Value {
    let kind = attachment.kind.unwrap_or("image");
    if kind == "audio" {
        return serde_json::json!({
            "type": "audio",
            "mimeType": attachment.mime_type,
            "data": attachment.base64
        });
    }
    let uri = format!("file:///attachments/{}", attachment.file_name);
    if is_text_mime(attachment.mime_type) {
        let text = decode_text(attachment.base64);
        return serde_json::json!({
            "type": "resource",
            "resource": { "uri": uri, "mimeType": attachment.mime_type, "text": text }
        });
    }
    serde_json::json!({
        "type": "resource",
        "resource": { "uri": uri, "mimeType": attachment.mime_type, "blob": attachment.base64 }
    })
}

fn is_text_mime(mime_type: &str) -> bool {
    mime_type.starts_with("text/")
        || matches!(
            mime_type,
            "application/json" | "application/xml" | "application/csv"
        )
}
