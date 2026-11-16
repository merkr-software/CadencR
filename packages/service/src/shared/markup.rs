//! Escaping text for HTML and XML markup.

/// Escape `value` for an attribute or text node of HTML or XML: `&`, `"`, `<`,
/// `>` and `'`.
pub fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::escape_attribute;

    #[test]
    fn escapes_every_markup_character() {
        assert_eq!(escape_attribute("A & \"B\""), "A &amp; &quot;B&quot;");
        assert_eq!(
            escape_attribute("<a href='x'>"),
            "&lt;a href=&apos;x&apos;&gt;"
        );
    }
}
