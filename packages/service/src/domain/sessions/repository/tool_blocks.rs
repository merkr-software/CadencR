//! Per-message-type handlers for the most complex `build_blocks` branches:
//! `tool_call` (with dedup + Bash arg-protection) and `tool_result` /
//! `tool_error` (with source-tool resolution, file-change patch recovery,
//! and Bash output truncation).
//!
//! Extracted from `build_blocks` so that the builder file fits under the
//! 400-line cap. These functions mutate the shared `all` / `tool_use_id_map`
//! / `root_indices` collections threaded through the builder.

use std::collections::HashMap;

use super::super::models::*;
use super::blocks::MutableBlock;
use super::truncation::{
    is_bash_tool_name, is_file_change_tool_name, truncate_bash_output, BASH_OUTPUT_MAX_LINES,
};

pub(super) fn handle_tool_call(
    msg: &AgentMessageRow,
    id: String,
    parent_idx: Option<usize>,
    all: &mut Vec<MutableBlock>,
    tool_use_id_map: &mut HashMap<String, usize>,
    root_indices: &mut Vec<usize>,
) {
    // Deduplicate: if tool_use_id already seen, update content if longer.
    // Exception: Bash tool_calls must keep their original args content
    // (e.g. {"command":..., "description":...}) — without this guard,
    // a stray duplicate row carrying the bash OUTPUT would overwrite
    // the args here, doubling the payload (the same output already
    // lives on the matching `tool_result` block).
    if let Some(tuid) = &msg.tool_use_id {
        if let Some(&existing_idx) = tool_use_id_map.get(tuid.as_str()) {
            if !is_bash_tool_name(all[existing_idx].tool_name.as_deref())
                && !msg.content.is_empty()
                && msg.content.len() > all[existing_idx].content.len()
            {
                all[existing_idx].content = msg.content.clone();
            }
            return;
        }
    }

    let is_task =
        msg.tool_name.as_deref() == Some("Task") || msg.tool_name.as_deref() == Some("Agent");
    // Defensive truncation for Bash tool_calls. The dedup gate
    // above prevents *new* rows from poisoning the tool_call with
    // command output, but historical rows in the DB already carry
    // the full output baked onto the tool_call. Treat the content
    // exactly like a Bash tool_result so the wire stays small.
    let is_bash_call = is_bash_tool_name(msg.tool_name.as_deref());
    let (call_content, call_truncated) = if is_bash_call {
        truncate_bash_output(&msg.content, BASH_OUTPUT_MAX_LINES)
    } else {
        (msg.content.clone(), false)
    };
    let new_idx = all.len();
    all.push(MutableBlock {
        id,
        type_: "tool_call".to_string(),
        content: call_content,
        tool_name: msg.tool_name.clone().or(Some("tool".to_string())),
        tool_use_id: msg.tool_use_id.clone(),
        parent_tool_use_id: msg.parent_tool_use_id.clone(),
        is_error: None,
        source_tool_name: None,
        created_at: msg.created_at.clone(),
        model: None,
        origin: msg.origin.clone(),
        has_child_slots: is_task,
        child_indices: Vec::new(),
        truncated_content: if call_truncated { Some(true) } else { None },
    });
    if let Some(tuid) = &msg.tool_use_id {
        tool_use_id_map.insert(tuid.clone(), new_idx);
    }
    if let Some(pidx) = parent_idx {
        all[pidx].child_indices.push(new_idx);
    } else {
        root_indices.push(new_idx);
    }
}

pub(super) fn handle_tool_result(
    msg: &AgentMessageRow,
    id: String,
    parent_idx: Option<usize>,
    all: &mut Vec<MutableBlock>,
    tool_use_id_map: &mut HashMap<String, usize>,
    root_indices: &mut Vec<usize>,
) {
    let is_error = msg.message_type == "tool_error";
    // Resolve source tool name
    let source_tool_name = msg
        .tool_use_id
        .as_deref()
        .and_then(|tuid| tool_use_id_map.get(tuid))
        .and_then(|&idx| all[idx].tool_name.clone())
        .or_else(|| {
            // Fallback: scan backwards for last tool_call in list
            let list = if let Some(pidx) = parent_idx {
                &all[pidx].child_indices as &[usize]
            } else {
                &*root_indices
            };
            list.iter()
                .rev()
                .find(|&&li| all[li].type_ == "tool_call")
                .and_then(|&li| all[li].tool_name.clone())
        });

    if let Some(tuid) = msg.tool_use_id.as_deref() {
        if let Some(&tool_idx) = tool_use_id_map.get(tuid) {
            if is_file_change_tool_name(all[tool_idx].tool_name.as_deref()) {
                merge_tool_result_patch(&mut all[tool_idx].content, &msg.content);
            }
        }
    }

    // Truncate Bash tool_result payloads to the last N lines on the
    // wire. The full output remains in `agent_messages.content` and
    // is reachable via `GET /api/sessions/messages/{id}/full`.
    let is_bash_result = is_bash_tool_name(source_tool_name.as_deref());
    let (result_content, was_truncated) = if is_bash_result {
        truncate_bash_output(&msg.content, BASH_OUTPUT_MAX_LINES)
    } else {
        (msg.content.clone(), false)
    };

    let new_idx = all.len();
    all.push(MutableBlock {
        id,
        type_: "tool_result".to_string(),
        content: result_content,
        tool_name: None,
        tool_use_id: msg.tool_use_id.clone(),
        parent_tool_use_id: msg.parent_tool_use_id.clone(),
        is_error: Some(is_error),
        source_tool_name,
        created_at: msg.created_at.clone(),
        model: None,
        origin: msg.origin.clone(),
        has_child_slots: false,
        child_indices: Vec::new(),
        truncated_content: if was_truncated { Some(true) } else { None },
    });
    // Nest under parent_tool_use_id if available, otherwise under the
    // matching Agent/Task tool_call (tool_result shares tool_use_id).
    let nest_idx = parent_idx.or_else(|| {
        msg.tool_use_id
            .as_deref()
            .and_then(|tuid| tool_use_id_map.get(tuid).copied())
            .filter(|&idx| all[idx].has_child_slots)
    });
    if let Some(pidx) = nest_idx {
        all[pidx].child_indices.push(new_idx);
    } else {
        root_indices.push(new_idx);
    }
}

fn merge_tool_result_patch(tool_call_content: &mut String, tool_result_content: &str) {
    let Ok(result) = serde_json::from_str::<serde_json::Value>(tool_result_content) else {
        return;
    };
    let Some(result_object) = result.as_object() else {
        return;
    };
    if !result_object.contains_key("patch_text") {
        return;
    }
    let mut base = serde_json::from_str::<serde_json::Value>(tool_call_content)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for (key, value) in result_object {
        base.entry(key.clone()).or_insert_with(|| value.clone());
    }
    if let Ok(content) = serde_json::to_string(&serde_json::Value::Object(base)) {
        *tool_call_content = content;
    }
}

#[cfg(test)]
mod tests {
    use super::super::blocks::build_blocks;
    use super::super::test_support::*;

    #[test]
    fn test_build_blocks_tool_call_with_result() {
        let msgs = vec![
            make_message_full(1, 1, "tool_call", "{}", Some("Bash"), Some("tu-1"), None),
            make_message_full(2, 1, "tool_result", "output", None, Some("tu-1"), None),
        ];
        let blocks = build_blocks(&msgs);
        // tool_result should be a root block (not nested under tool_call unless parent_tool_use_id set)
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].type_, "tool_call");
        assert_eq!(blocks[1].type_, "tool_result");
        assert_eq!(blocks[1].source_tool_name.as_deref(), Some("Bash"));
    }

    #[test]
    fn test_build_blocks_recovers_file_change_patch_from_result() {
        let msgs = vec![
            make_message_full(
                1,
                1,
                "tool_call",
                r#"{"output":"Success"}"#,
                Some("ApplyPatch"),
                Some("patch-1"),
                None,
            ),
            make_message_full(
                2,
                1,
                "tool_result",
                r#"{"patch_text":"*** Begin Patch\n*** Update File: toto.txt\n@@\n-old\n+new\n*** End Patch","status":"completed"}"#,
                None,
                Some("patch-1"),
                None,
            ),
        ];

        let blocks = build_blocks(&msgs);
        assert_eq!(blocks[0].type_, "tool_call");
        let content: serde_json::Value = serde_json::from_str(&blocks[0].content).unwrap();
        assert_eq!(content["output"], "Success");
        assert_eq!(
            content["patch_text"],
            "*** Begin Patch\n*** Update File: toto.txt\n@@\n-old\n+new\n*** End Patch"
        );
    }

    #[test]
    fn test_build_blocks_tool_call_deduplication() {
        // Non-Bash tools (Edit/Write) legitimately accumulate args via
        // `input_json_delta`, so the longer content should win.
        let msgs = vec![
            make_message_full(1, 1, "tool_call", "{}", Some("Edit"), Some("tu-dup"), None),
            make_message_full(
                2,
                1,
                "tool_call",
                "{\"file_path\":\"/x.txt\"}",
                Some("Edit"),
                Some("tu-dup"),
                None,
            ),
        ];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 1, "duplicate tool_use_id should deduplicate");
        assert_eq!(blocks[0].type_, "tool_call");
        // content updated to longer version
        assert_eq!(blocks[0].content, "{\"file_path\":\"/x.txt\"}");
    }

    #[test]
    fn test_build_blocks_bash_dedupe_does_not_overwrite_args() {
        // Bash tool_call args must never be replaced by a later same-tool_use_id
        // row carrying the bash OUTPUT — that's the 2x-payload regression the
        // dedupe gate prevents. The output stays exclusively on tool_result.
        let original_args = r#"{"command":"ls -la","description":"list files"}"#;
        let giant_output = "A".repeat(1_000_000);
        let msgs = vec![
            make_message_full(
                1,
                1,
                "tool_call",
                original_args,
                Some("Bash"),
                Some("tu-bash"),
                None,
            ),
            // Stray duplicate with a much longer payload — must be ignored.
            make_message_full(
                2,
                1,
                "tool_call",
                &giant_output,
                Some("Bash"),
                Some("tu-bash"),
                None,
            ),
        ];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 1, "Bash dup should still dedupe to one block");
        assert_eq!(blocks[0].type_, "tool_call");
        assert_eq!(
            blocks[0].content, original_args,
            "Bash tool_call content must not be overwritten by a larger duplicate"
        );
    }

    #[test]
    fn test_build_blocks_nested_agent_tool() {
        let msgs = vec![make_message_full(
            1,
            1,
            "tool_call",
            "{}",
            Some("Task"),
            Some("tu-task"),
            None,
        )];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].type_, "tool_call");
        // Task tool should have child_blocks slot (empty vec)
        assert!(
            blocks[0].child_blocks.is_some(),
            "Task tool should have child_blocks"
        );
    }

    #[test]
    fn test_build_blocks_tool_result_nests_under_agent_via_tool_use_id() {
        // Agent tool_result has parent_tool_use_id=None but shares tool_use_id with Agent tool_call.
        // build_blocks should nest it as a child of the Agent block.
        let msgs = vec![
            make_message_full(
                1,
                1,
                "tool_call",
                "{\"prompt\":\"explore\"}",
                Some("Agent"),
                Some("tu-agent"),
                None,
            ),
            // Sub-agent child messages
            make_message_full(
                2,
                1,
                "tool_call",
                "{\"command\":\"ls\"}",
                Some("Bash"),
                Some("tu-bash"),
                Some("tu-agent"),
            ),
            make_message_full(
                3,
                1,
                "tool_result",
                "file.txt",
                None,
                Some("tu-bash"),
                Some("tu-agent"),
            ),
            // Agent tool_result: same tool_use_id as Agent, no parent_tool_use_id
            make_message_full(
                4,
                1,
                "tool_result",
                "[{\"text\":\"Done\"}]",
                None,
                Some("tu-agent"),
                None,
            ),
        ];
        let blocks = build_blocks(&msgs);
        // Only the Agent block at root level
        assert_eq!(
            blocks.len(),
            1,
            "Agent tool_result should not be a root block"
        );
        let agent = &blocks[0];
        assert_eq!(agent.type_, "tool_call");
        let children = agent.child_blocks.as_ref().unwrap();
        assert_eq!(
            children.len(),
            3,
            "Agent should have 3 children: Bash call, Bash result, Agent result"
        );
        assert_eq!(children[2].type_, "tool_result");
        assert_eq!(children[2].source_tool_name.as_deref(), Some("Agent"));
        assert_eq!(children[2].content, "[{\"text\":\"Done\"}]");
    }
}
