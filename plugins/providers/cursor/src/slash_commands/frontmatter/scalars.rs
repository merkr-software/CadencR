//! Scalar helpers for the frontmatter subset: plain-scalar typing, quoted
//! scalars (escapes and line folding), folded block scalars, flow sequences.

use super::Node;

pub(super) fn fold(lines: &[&str]) -> String {
    let mut text = String::new();
    let mut previous_more_indented: Option<bool> = None;
    let mut empties = 0;
    for line in lines {
        if line.is_empty() {
            empties += 1;
            continue;
        }
        let more_indented = line.starts_with([' ', '\t']);
        match previous_more_indented {
            None => text.push_str(&"\n".repeat(empties)),
            Some(previous) if previous || more_indented => {
                text.push_str(&"\n".repeat(empties + 1));
            }
            Some(_) if empties == 0 => text.push(' '),
            Some(_) => text.push_str(&"\n".repeat(empties)),
        }
        text.push_str(line);
        previous_more_indented = Some(more_indented);
        empties = 0;
    }
    text
}

pub(super) fn strip_comment(text: &str) -> &str {
    text.find(" #").map_or(text, |index| &text[..index])
}

/// js-yaml refuses a mapping indicator inside a block plain scalar.
pub(super) fn check_plain(text: &str) -> Result<(), String> {
    if text.contains(": ") || text.ends_with(':') {
        return Err(format!("mapping values are not allowed here: {text:?}"));
    }
    Ok(())
}

pub(super) fn resolve_plain(text: String) -> Node {
    match text.as_str() {
        "" | "~" | "null" | "Null" | "NULL" => Node::Null,
        "true" | "True" | "TRUE" => Node::Bool(true),
        "false" | "False" | "FALSE" => Node::Bool(false),
        ".inf" | "-.inf" | "+.inf" | ".Inf" | ".INF" | ".nan" | ".NaN" | ".NAN" => Node::Number,
        number if is_number(number) => Node::Number,
        _ => Node::Str(text),
    }
}

fn is_number(text: &str) -> bool {
    let digits = text
        .strip_prefix(['-', '+'])
        .unwrap_or(text)
        .replace('_', "");
    if let Some(hex) = digits.strip_prefix("0x") {
        return !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    if let Some(octal) = digits.strip_prefix("0o") {
        return !octal.is_empty() && octal.chars().all(|c| c.is_digit(8));
    }
    !digits.is_empty()
        && digits.starts_with(|c: char| c.is_ascii_digit() || c == '.')
        && digits.parse::<f64>().is_ok()
}

pub(super) fn closing_quote(raw: &str, quote: char) -> Option<usize> {
    let mut chars = raw.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        match ch {
            '\\' if quote == '"' => {
                chars.next();
            }
            _ if ch == quote => {
                if quote == '\'' && chars.peek().is_some_and(|&(_, next)| next == '\'') {
                    chars.next();
                } else {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// Unescape, and fold the line breaks of a multi-line quoted scalar.
pub(super) fn unquote(raw: &str, quote: char) -> String {
    let mut folded = String::new();
    let mut lines = raw.split('\n').peekable();
    let mut empties = 0;
    let mut first = true;
    while let Some(line) = lines.next() {
        let is_last = lines.peek().is_none();
        let line = if first { line } else { line.trim() };
        if !first && line.is_empty() && !is_last {
            empties += 1;
            continue;
        }
        if !first {
            if folded.ends_with('\\') && quote == '"' {
                folded.pop();
            } else {
                folded.push_str(&if empties > 0 {
                    "\n".repeat(empties)
                } else {
                    " ".into()
                });
            }
        }
        folded.push_str(line);
        empties = 0;
        first = false;
    }
    if quote == '\'' {
        return folded.replace("''", "'");
    }
    unescape(&folded)
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let hex = |chars: &mut std::str::Chars<'_>, count: usize| {
            let digits: String = chars.by_ref().take(count).collect();
            u32::from_str_radix(&digits, 16)
                .ok()
                .and_then(char::from_u32)
        };
        let escaped = match chars.next() {
            Some('n') => Some('\n'),
            Some('t') => Some('\t'),
            Some('r') => Some('\r'),
            Some('0') => Some('\0'),
            Some('x') => hex(&mut chars, 2),
            Some('u') => hex(&mut chars, 4),
            Some('U') => hex(&mut chars, 8),
            Some(other) => Some(other),
            None => None,
        };
        out.extend(escaped);
    }
    out
}

pub(super) fn flow_sequence(text: &str) -> Result<Node, String> {
    let inner = strip_comment(text)
        .trim()
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .ok_or("unterminated flow sequence")?;
    Ok(Node::Seq(
        inner
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| {
                let unquoted = item
                    .strip_prefix('"')
                    .and_then(|i| i.strip_suffix('"'))
                    .or_else(|| item.strip_prefix('\'').and_then(|i| i.strip_suffix('\'')));
                match unquoted {
                    Some(value) => Node::Str(value.to_string()),
                    None => resolve_plain(item.to_string()),
                }
            })
            .collect(),
    ))
}
