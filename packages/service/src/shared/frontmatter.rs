//! Top-level scalars of a `---` fenced YAML front matter, as agent CLIs write
//! it at the top of `SKILL.md` and agent definition files. Enough to read a
//! name or a model without a YAML parser: nested keys, lists and block
//! scalars (`>`, `|`) are skipped.

use std::collections::BTreeMap;

/// Every top-level `key: value` with a non-empty scalar value. Text without
/// an opening `---` fence has no front matter.
pub fn scalars(content: &str) -> BTreeMap<&str, String> {
    let mut found = BTreeMap::new();
    let mut lines = content.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return found;
    }
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if let Some(value) = scalar(value) {
            found.insert(key.trim(), value);
        }
    }
    found
}

fn scalar(value: &str) -> Option<String> {
    let value = value.trim();
    let value = match value.chars().next() {
        Some('"') => double_quoted(&value[1..]),
        Some('\'') => single_quoted(&value[1..]),
        _ => value.split(" #").next().unwrap_or_default().to_string(),
    };
    let value = value.trim();
    (!value.is_empty() && value != ">" && value != "|").then(|| value.to_string())
}

/// A `"…"` scalar up to its closing quote; `\x` escapes read as `x`, and
/// `\n` / `\t` as a space.
fn double_quoted(rest: &str) -> String {
    let mut text = String::new();
    let mut chars = rest.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => break,
            '\\' => match chars.next() {
                Some('n' | 't') => text.push(' '),
                Some(escaped) => text.push(escaped),
                None => break,
            },
            _ => text.push(ch),
        }
    }
    text
}

/// A `'…'` scalar up to its closing quote; `''` reads as `'`.
fn single_quoted(rest: &str) -> String {
    let mut text = String::new();
    let mut chars = rest.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\'' {
            text.push(ch);
        } else if chars.next_if_eq(&'\'').is_some() {
            text.push('\'');
        } else {
            break;
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_top_level_scalars_only() {
        let content = "\u{feff}---\r\nname: reviewer\r\ndescription: \"Reviews: code\"\nmodel: sonnet # fast\neffort: 'high'\ntools:\n  - Read\nsummary: >\n  folded\n---\nmodel: opus\n";
        let found = scalars(content);
        assert_eq!(found["name"], "reviewer");
        assert_eq!(found["description"], "Reviews: code");
        assert_eq!(found["model"], "sonnet");
        assert_eq!(found["effort"], "high");
        assert!(!found.contains_key("tools"));
        assert!(!found.contains_key("summary"));
    }

    #[test]
    fn quoted_scalars_keep_their_escaped_quotes() {
        let found = scalars(
            "---\ndescription: \"Use when the user says \\\"review\\\"\"\nsummary: 'It''s fast'\n---\n",
        );
        assert_eq!(found["description"], "Use when the user says \"review\"");
        assert_eq!(found["summary"], "It's fast");
    }

    #[test]
    fn text_without_a_fence_has_none() {
        assert!(scalars("model: opus\n").is_empty());
    }
}
