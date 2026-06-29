//! Pure transcript-surgery helpers for Claude Code's JSONL session files.
//!
//! Claude stores each session as `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`,
//! one JSON event per line. To branch a session's context at a point in time we
//! keep a *prefix* of those lines and rewrite their `sessionId` to a new id, so
//! resuming the new id replays exactly the kept context and nothing after.
//!
//! Everything here operates on already-parsed `serde_json::Value`s and is I/O-
//! free, so the cut/rewrite logic is unit-testable against fixtures. The format
//! is version-unstable (per Anthropic docs), so we only ever read the handful of
//! fields we need and never deserialize into a strict struct.

use serde_json::Value;

/// Whether a JSONL line is a *real user prompt* — the thing a rewind/fork cut
/// targets — as opposed to a tool-result user echo or an injected meta line.
///
/// A user prompt line is `type == "user"` whose `message.content` is a plain
/// string or an array carrying at least one non-`tool_result` block, and which
/// is not flagged `isMeta`. Tool results (content is entirely `tool_result`
/// blocks) and meta lines are skipped so the ordinal lines up with Cadencr's
/// `user_message` rows.
pub(super) fn is_real_user_prompt(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    // Injected lines that are not user-typed prompts: meta markers and the
    // post-compaction summary Claude writes as a synthetic `user` line. These
    // have no matching Cadencr `user_message` row, so counting them would skew
    // the ordinal.
    if value.get("isMeta").and_then(Value::as_bool) == Some(true)
        || value.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
    {
        return false;
    }
    match value.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => items
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) != Some("tool_result")),
        _ => false,
    }
}

/// Cheap sanity check that the file looks like a Claude transcript at all, so a
/// totally-foreign or corrupt file triggers the orchestrator's fallback instead
/// of producing a garbage branch. We require at least one line carrying a
/// `type` field.
pub(super) fn looks_like_transcript(lines: &[Value]) -> bool {
    lines
        .iter()
        .any(|v| v.get("type").and_then(Value::as_str).is_some())
}

/// Resolve the cut index: the kept prefix is `lines[..cut]`.
///
/// Prefers an exact `uuid` match (robust to reshaping); otherwise cuts before
/// the `cut_user_ordinal`-th real user prompt. An ordinal of 0 or 1 keeps
/// nothing (a fresh context before the first prompt). Returns `None` when the
/// ordinal can't be located, so the caller can fall back rather than guess.
pub(super) fn resolve_cut_index(
    lines: &[Value],
    cut_provider_uuid: Option<&str>,
    cut_user_ordinal: usize,
) -> Option<usize> {
    if let Some(uuid) = cut_provider_uuid {
        if let Some(idx) = lines
            .iter()
            .position(|v| v.get("uuid").and_then(Value::as_str) == Some(uuid))
        {
            return Some(idx);
        }
    }

    if cut_user_ordinal <= 1 {
        return Some(0);
    }

    let mut seen = 0;
    for (idx, value) in lines.iter().enumerate() {
        if is_real_user_prompt(value) {
            seen += 1;
            if seen == cut_user_ordinal {
                return Some(idx);
            }
        }
    }
    None
}

/// Serialize the kept lines back to JSONL with each line's `sessionId` rewritten
/// to `new_id`, so the resume chain is self-consistent. `parentUuid` chains are
/// left intact — a truncated prefix is a valid conversation leaf.
pub(super) fn rewrite_session_id(lines: &[Value], new_id: &str) -> String {
    let mut out = String::new();
    for value in lines {
        let mut value = value.clone();
        if let Value::Object(map) = &mut value {
            map.insert("sessionId".to_string(), Value::String(new_id.to_string()));
        }
        out.push_str(&serde_json::to_string(&value).unwrap_or_default());
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user_prompt(uuid: &str, text: &str) -> Value {
        json!({"type": "user", "uuid": uuid, "sessionId": "old",
               "message": {"role": "user", "content": text}})
    }
    fn assistant(uuid: &str) -> Value {
        json!({"type": "assistant", "uuid": uuid, "sessionId": "old",
               "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}})
    }
    fn tool_result(uuid: &str) -> Value {
        json!({"type": "user", "uuid": uuid, "sessionId": "old",
               "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "x"}]}})
    }

    #[test]
    fn is_real_user_prompt_excludes_tool_results_and_meta() {
        assert!(is_real_user_prompt(&user_prompt("u", "hello")));
        assert!(!is_real_user_prompt(&tool_result("u")));
        assert!(!is_real_user_prompt(&assistant("u")));
        let meta = json!({"type": "user", "isMeta": true,
            "message": {"content": "x"}});
        assert!(!is_real_user_prompt(&meta));
    }

    #[test]
    fn resolve_cut_index_prefers_uuid() {
        let lines = vec![
            user_prompt("p1", "first"),
            assistant("a1"),
            user_prompt("p2", "second"),
            assistant("a2"),
        ];
        // Cut before the line with uuid p2 → keep [p1, a1].
        assert_eq!(resolve_cut_index(&lines, Some("p2"), 99), Some(2));
    }

    #[test]
    fn resolve_cut_index_falls_back_to_ordinal_skipping_tool_results() {
        let lines = vec![
            user_prompt("p1", "first"),
            assistant("a1"),
            tool_result("tr"), // a `user` line that must NOT count
            user_prompt("p2", "second"),
            assistant("a2"),
        ];
        // 2nd real user prompt is p2 at index 3.
        assert_eq!(resolve_cut_index(&lines, None, 2), Some(3));
        // 1st prompt → keep nothing.
        assert_eq!(resolve_cut_index(&lines, None, 1), Some(0));
        // Out-of-range ordinal → None (caller falls back).
        assert_eq!(resolve_cut_index(&lines, None, 9), None);
    }

    #[test]
    fn resolve_cut_index_uuid_miss_then_ordinal() {
        let lines = vec![
            user_prompt("p1", "first"),
            assistant("a1"),
            user_prompt("p2", "x"),
        ];
        // uuid not present → use ordinal (2nd prompt at idx 2).
        assert_eq!(resolve_cut_index(&lines, Some("nope"), 2), Some(2));
    }

    #[test]
    fn rewrite_session_id_sets_new_id_on_every_kept_line() {
        let lines = vec![user_prompt("p1", "first"), assistant("a1")];
        let out = rewrite_session_id(&lines, "new-123");
        let parsed: Vec<Value> = out
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(parsed.len(), 2);
        for line in &parsed {
            assert_eq!(line["sessionId"], "new-123");
        }
        // parentUuid/uuid chains untouched.
        assert_eq!(parsed[0]["uuid"], "p1");
    }

    #[test]
    fn looks_like_transcript_rejects_foreign_content() {
        assert!(looks_like_transcript(&[json!({"type": "user"})]));
        assert!(!looks_like_transcript(&[json!({"foo": "bar"})]));
    }
}
