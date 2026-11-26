use std::sync::LazyLock;

use tokio::sync::OwnedMutexGuard;

use crate::shared::keyed_locks::KeyedLocks;

pub const MANUAL_TITLE_SETTING_KEY: &str = "title_manually_set";
pub(crate) const MANUAL_TITLE_REVISION_SETTING_KEY: &str = "manual_title_revision";

/// Order title writes and notifications. Manual edits remain available while
/// the naming provider generates a title.
pub(crate) async fn lock_title_updates(feature_id: i64) -> OwnedMutexGuard<()> {
    static TITLE_UPDATES: LazyLock<KeyedLocks<i64>> = LazyLock::new(KeyedLocks::default);
    TITLE_UPDATES.lock_for(&feature_id).await.lock_owned().await
}

#[derive(Clone, Copy)]
pub enum GeneratedTitlePolicy<'a> {
    PreserveManualTitle,
    ReplaceIfManualTitleUnchanged { revision: Option<&'a str> },
}

/// Whether a title is one of the placeholders assigned before the first
/// prompt is named.
pub fn is_default_title(title: &str) -> bool {
    if title == "Untitled Feature" {
        return true;
    }
    let mut parts = title.split(' ');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(prefix), Some(number), None)
            if prefix.eq_ignore_ascii_case("session")
                && !number.is_empty()
                && number.bytes().all(|byte| byte.is_ascii_digit())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_placeholder_titles() {
        assert!(is_default_title("Session 1"));
        assert!(is_default_title("session 42"));
        assert!(is_default_title("Untitled Feature"));
        assert!(!is_default_title("Fix Login Bug"));
        assert!(!is_default_title("Session about logins"));
        assert!(!is_default_title("Session 1 extra"));
    }
}
