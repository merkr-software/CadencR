use base64::Engine;

#[derive(Clone, Copy)]
pub struct RuntimePromptAttachment<'a> {
    pub base64: &'a str,
    pub mime_type: &'a str,
    pub file_name: &'a str,
    pub kind: Option<&'a str>,
}

pub(crate) fn default_prompt_attachment_block(
    attachment: &RuntimePromptAttachment<'_>,
) -> serde_json::Value {
    let kind = attachment.kind.unwrap_or("image");
    if kind == "document" {
        return serde_json::json!({
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": attachment.mime_type,
                "data": attachment.base64
            },
            "title": attachment.file_name
        });
    }
    text_block(&format!(
        "Attached file `{}` ({})\n\n{}",
        attachment.file_name,
        attachment.mime_type,
        decode_text(attachment.base64)
    ))
}

fn text_block(text: &str) -> serde_json::Value {
    serde_json::json!({"type":"text","text":text})
}

pub(crate) fn decode_text(base64_data: &str) -> String {
    decode_text_if_valid(base64_data).unwrap_or_else(|| "[binary content omitted]".to_string())
}

fn decode_text_if_valid(base64_data: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .ok()?;
    String::from_utf8(bytes).ok()
}
