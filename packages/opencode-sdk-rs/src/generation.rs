//! Which OpenCode CLI line a binary belongs to.
//!
//! OpenCode 2.x (npm `@opencode/cli`) keeps the `opencode` binary name and the
//! data directory of 1.x (npm `opencode-ai`) but changes the CLI surface, the
//! ACP transport and the database schema. Callers pick the matching protocol
//! from the version the discovery probe already read.

use cli_discovery::VersionKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeGeneration {
    /// 1.x: `opencode acp --port` serves an HTTP side channel next to ACP.
    V1,
    /// 2.x: stdio-only ACP; HTTP goes through `opencode api --standalone`.
    V2,
}

impl OpenCodeGeneration {
    /// A binary whose version could not be read keeps the 1.x protocol, the one
    /// every earlier Cadencr release spoke.
    pub fn from_version(version: Option<&VersionKey>) -> Self {
        match version {
            Some(VersionKey(major, _, _)) if *major >= 2 => Self::V2,
            _ => Self::V1,
        }
    }

    pub fn is_v2(self) -> bool {
        self == Self::V2
    }
}

/// A resolved `opencode` binary and the CLI line it speaks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeInstallation {
    pub path: std::path::PathBuf,
    pub generation: OpenCodeGeneration,
}

#[cfg(test)]
mod tests {
    use super::OpenCodeGeneration;
    use cli_discovery::{parse_version_string, VersionKey};

    #[test]
    fn v2_cli_version_output_selects_the_v2_protocol() {
        let version = parse_version_string("opencode v2.3.2");
        assert_eq!(version, Some(VersionKey(2, 3, 2)));
        assert_eq!(
            OpenCodeGeneration::from_version(version.as_ref()),
            OpenCodeGeneration::V2
        );
    }

    #[test]
    fn v1_and_unreadable_versions_keep_the_v1_protocol() {
        let v1 = parse_version_string("1.19.6");
        assert_eq!(
            OpenCodeGeneration::from_version(v1.as_ref()),
            OpenCodeGeneration::V1
        );
        assert_eq!(
            OpenCodeGeneration::from_version(None),
            OpenCodeGeneration::V1
        );
    }
}
