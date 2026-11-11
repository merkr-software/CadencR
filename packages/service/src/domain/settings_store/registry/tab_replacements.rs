//! `custom_tab_replacements`: which custom tab shows in place of a built-in
//! feature-page tab (`docs/CUSTOM_TABS.md` §10), e.g. `{"git":"my-vcs"}`.
//!
//! Only the shape is checked here. Whether the tab exists, declares the slot in
//! `tab.replaces` and may run in a project is decided where it is shown, since
//! all three change without this value being written.

use std::collections::BTreeSet;

use cadencr_plugin_core::tab::{is_valid_tab_id, REPLACEABLE_TABS};
use serde_json::Value;

/// A JSON object whose keys are replaceable built-in tabs and whose values are
/// distinct custom tab ids: one tab stands in for one built-in at a time.
pub(super) fn is_valid(value: &str) -> bool {
    let Ok(Value::Object(choices)) = serde_json::from_str::<Value>(value) else {
        return false;
    };
    let mut tabs = BTreeSet::new();
    choices.iter().all(|(slot, tab)| {
        REPLACEABLE_TABS.contains(&slot.as_str())
            && tab
                .as_str()
                .is_some_and(|id| is_valid_tab_id(id) && tabs.insert(id))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_distinct_tabs_in_replaceable_slots() {
        for valid in [
            "{}",
            r#"{"git":"my-vcs"}"#,
            r#"{"git":"my-vcs","terminal":"shell-plus","editor":"ide","preview":"docs"}"#,
        ] {
            assert!(is_valid(valid), "{valid}");
        }
    }

    #[test]
    fn rejects_other_shapes_slots_ids_and_shared_tabs() {
        for invalid in [
            "",
            "[]",
            r#""git""#,
            r#"{"agent":"a"}"#,
            r#"{"browser":"a"}"#,
            r#"{"git":"Bad Id"}"#,
            r#"{"git":null}"#,
            r#"{"git":"a","editor":"a"}"#,
        ] {
            assert!(!is_valid(invalid), "{invalid}");
        }
    }
}
