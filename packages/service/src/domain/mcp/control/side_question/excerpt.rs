//! The excerpt of the source conversation a side question is seeded with.

use crate::error::AppError;

/// Recent turns copied into the side conversation (oldest dropped first).
const EXCERPT_MESSAGES: i64 = 16;
const EXCERPT_MESSAGE_CHARS: usize = 900;
/// Read per message before visuals are dropped: a chart can fill a reply's
/// first kilobytes, and the prose around it is what the excerpt is for.
const EXCERPT_READ_CHARS: usize = 24_000;

/// Fences the transcript renders as a chart, visual or diagram, with what
/// stands in for each. Their source tells the side agent nothing, and a fence
/// cut mid-way by the excerpt would render broken in the side conversation's
/// first message. Mirrors `RENDERED_FENCES` in the desktop's
/// `components/markdown/markdown-components.tsx` (same exact, case-sensitive
/// names).
const RENDERED_FENCES: [(&str, &str); 3] = [
    ("vega-lite", "[chart omitted]"),
    ("cadencr-html", "[visual omitted]"),
    ("mermaid", "[diagram omitted]"),
];

#[derive(sqlx::FromRow)]
struct ExcerptRow {
    role: String,
    content: String,
}

pub(super) fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let clipped: String = trimmed.chars().take(max).collect();
    format!("{clipped}…")
}

/// A fenced code block's opening line: its marker, the marker's length, and
/// the language word after it (empty when none).
struct FenceOpen<'a> {
    marker: char,
    length: usize,
    language: &'a str,
}

fn fence_open(line: &str) -> Option<FenceOpen<'_>> {
    let trimmed = line.trim_start();
    let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let length = trimmed.chars().take_while(|c| *c == marker).count();
    if length < 3 {
        return None;
    }
    let language = trimmed[length..].split_whitespace().next().unwrap_or("");
    Some(FenceOpen {
        marker,
        length,
        language,
    })
}

fn closes_fence(line: &str, marker: char, length: usize) -> bool {
    let trimmed = line.trim();
    trimmed.chars().count() >= length && trimmed.chars().all(|c| c == marker)
}

/// `text` with every top-level chart, visual and diagram fence replaced by a
/// short placeholder. Fences nested in another code block are that block's
/// content and stay; an unclosed rendered fence (the reply was clipped) runs
/// to the end.
fn strip_rendered_fences(text: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    // The open fence's marker and length, and whether it is being dropped.
    let mut open: Option<(char, usize, bool)> = None;
    for line in text.lines() {
        if let Some((marker, length, dropped)) = open {
            if closes_fence(line, marker, length) {
                open = None;
            }
            if !dropped {
                kept.push(line);
            }
            continue;
        }
        let Some(fence) = fence_open(line) else {
            kept.push(line);
            continue;
        };
        let placeholder = RENDERED_FENCES
            .iter()
            .find(|(name, _)| *name == fence.language)
            .map(|(_, placeholder)| *placeholder);
        kept.push(placeholder.unwrap_or(line));
        open = Some((fence.marker, fence.length, placeholder.is_some()));
    }
    kept.join("\n")
}

/// `text` clipped to `max` characters, closing a code block the cut left
/// open so it can't swallow the rest of the brief.
fn clip_closing_fence(text: &str, max: usize) -> String {
    let clipped = clip(text, max);
    let mut open: Option<(char, usize)> = None;
    for line in clipped.lines() {
        match open {
            Some((marker, length)) if closes_fence(line, marker, length) => open = None,
            Some(_) => {}
            None => open = fence_open(line).map(|fence| (fence.marker, fence.length)),
        }
    }
    match open {
        Some((marker, length)) => format!("{clipped}\n{}", marker.to_string().repeat(length)),
        None => clipped,
    }
}

/// The source conversation's latest user prompts and agent replies, oldest
/// first, as `User:` / `Agent:` lines, without their charts and visuals.
pub(super) async fn conversation_excerpt(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<String, AppError> {
    let mut rows: Vec<ExcerptRow> = sqlx::query_as(
        "SELECT role, substr(content, 1, ?) AS content FROM agent_messages
         WHERE session_id = ?
           AND ((role = 'user' AND message_type = 'user_message')
             OR (role = 'assistant' AND message_type = 'text'))
           AND TRIM(content) <> ''
         ORDER BY id DESC LIMIT ?",
    )
    // Clipped in SQL: a reply can be hundreds of KB.
    .bind(EXCERPT_READ_CHARS as i64)
    .bind(session_id)
    .bind(EXCERPT_MESSAGES)
    .fetch_all(pool)
    .await?;
    rows.reverse();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let content = strip_rendered_fences(&row.content);
            if content.trim().is_empty() {
                return None;
            }
            let who = if row.role == "user" { "User" } else { "Agent" };
            Some(format!(
                "{who}: {}",
                clip_closing_fence(&content, EXCERPT_MESSAGE_CHARS)
            ))
        })
        .collect::<Vec<_>>()
        .join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_short_text_and_marks_cuts() {
        assert_eq!(clip("  hello ", 10), "hello");
        assert_eq!(clip("abcdef", 3), "abc…");
    }

    #[test]
    fn charts_visuals_and_diagrams_become_placeholders() {
        let reply = "Here is the trend:\n\n```vega-lite\n{\"mark\": \"bar\"}\n```\n\n\
                     And the page:\n~~~~cadencr-html\n<div>```</div>\n~~~~\n\
                     ```mermaid\ngraph TD\n```\nDone.";
        assert_eq!(
            strip_rendered_fences(reply),
            "Here is the trend:\n\n[chart omitted]\n\nAnd the page:\n[visual omitted]\n\
             [diagram omitted]\nDone."
        );
    }

    #[test]
    fn an_unclosed_visual_runs_to_the_end() {
        assert_eq!(
            strip_rendered_fences("Look:\n```cadencr-html\n<div>cut mid-wa"),
            "Look:\n[visual omitted]"
        );
    }

    #[test]
    fn a_rendered_fence_inside_another_code_block_stays() {
        let reply = "````markdown\n```mermaid\ngraph TD\n```\n````\nAfter.";
        assert_eq!(strip_rendered_fences(reply), reply);
    }

    #[test]
    fn names_match_the_renderer_exactly() {
        let reply = "```Mermaid\ngraph TD\n```";
        assert_eq!(strip_rendered_fences(reply), reply);
    }

    #[test]
    fn a_code_block_cut_by_the_clip_is_closed() {
        let clipped = clip_closing_fence("See:\n```rust\nfn main() { let x = 1; }", 24);
        assert_eq!(clipped, "See:\n```rust\nfn main() {…\n```");
        assert_eq!(clip_closing_fence("```\nok\n```", 50), "```\nok\n```");
    }

    #[test]
    fn other_code_blocks_stay() {
        let reply = "```rust\nfn main() {}\n```\n```\nplain\n```";
        assert_eq!(strip_rendered_fences(reply), reply);
    }
}
