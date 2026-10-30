use crate::domain::agents::adapter::RuntimePromptAttachment;
pub(super) fn attachment_block(attachment: &RuntimePromptAttachment<'_>) -> serde_json::Value {
    let kind = attachment.kind.unwrap_or("image");
    serde_json::json!({
        "type": "attachment",
        "file_name": attachment.file_name,
        "kind": kind,
        "media_type": attachment.mime_type,
        "data": attachment.base64
    })
}
