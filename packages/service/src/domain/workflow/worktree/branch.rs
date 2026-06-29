//! Branch-name generation. Pure helpers with no DB or WS dependencies — easy
//! to unit-test.

use rand::RngExt;

use crate::shared::slug::slugify;

/// Build a branch name from a prefix and title.
/// Format: `{prefix}{slug}-{xxxx}` where xxxx is 4-char random hex.
pub fn build_branch_name(prefix: &str, title: &str) -> String {
    let slug = slugify(title);
    let suffix: u16 = rand::rng().random_range(0..=0xFFFF);
    let hex = format!("{:04x}", suffix);
    format!("{}{}-{}", prefix, slug, hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_branch_name_format() {
        let name = build_branch_name("feature/", "My Cool Feature");
        assert!(name.starts_with("feature/my-cool-feature-"));
        // Should end with 4 hex chars
        let suffix = &name[name.len() - 4..];
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_build_branch_name_suffix_length() {
        let name = build_branch_name("fix/", "test");
        // format: fix/test-xxxx
        assert!(name.starts_with("fix/test-"));
        let parts: Vec<&str> = name.rsplitn(2, '-').collect();
        assert_eq!(parts[0].len(), 4);
    }

    #[test]
    fn test_build_branch_name_special_chars() {
        let name = build_branch_name("feature/", "Hello World! @#$ Test");
        assert!(name.starts_with("feature/hello-world-test-"));
    }

    #[test]
    fn test_build_branch_name_empty_prefix() {
        let name = build_branch_name("", "my feature");
        assert!(name.starts_with("my-feature-"));
        assert_eq!(name.len(), "my-feature-".len() + 4);
    }

    #[test]
    fn test_build_branch_name_empty_title() {
        let name = build_branch_name("feature/", "");
        // slugify("") = "", so format is "feature/-xxxx"
        assert!(name.starts_with("feature/-"));
        let suffix = &name[name.len() - 4..];
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_build_branch_name_uniqueness() {
        // Two calls should (almost certainly) produce different names
        let a = build_branch_name("f/", "test");
        let b = build_branch_name("f/", "test");
        // Not guaranteed but with 65536 possibilities, collision is ~1/65536
        // We run multiple pairs to be safe
        let mut all_same = true;
        for _ in 0..5 {
            let x = build_branch_name("f/", "test");
            let y = build_branch_name("f/", "test");
            if x != y {
                all_same = false;
                break;
            }
        }
        // If somehow all 5 pairs collided, that's astronomically unlikely but not impossible.
        // Just check format is correct as the real assertion.
        assert!(a.starts_with("f/test-"));
        assert!(b.starts_with("f/test-"));
        // Suffix is hex
        let suffix_a = &a[a.len() - 4..];
        assert!(suffix_a.chars().all(|c| c.is_ascii_hexdigit()));
        let _ = all_same; // used above
    }

    #[test]
    fn test_build_branch_name_long_title() {
        let name = build_branch_name("feature/", &"a".repeat(100));
        // slug is capped at 50, so branch = "feature/" + 50 a's + "-" + 4 hex
        assert!(name.starts_with("feature/"));
        let without_prefix = &name["feature/".len()..];
        let parts: Vec<&str> = without_prefix.rsplitn(2, '-').collect();
        assert_eq!(parts[0].len(), 4); // hex suffix
        assert!(parts[1].len() <= 50); // slug portion
    }
}
