//! The platforms a tab backend can ship a native binary for (`backend.binary`
//! keys). A closed set: Cadencr only launches executables it can recognize as
//! native for the OS it runs on, and v1 knows two formats (Mach-O, ELF).

use std::fmt;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One `backend.binary` key. Windows is not supported yet.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ToSchema,
)]
pub enum TabPlatform {
    #[serde(rename = "darwin-aarch64")]
    DarwinAarch64,
    #[serde(rename = "darwin-x86_64")]
    DarwinX86_64,
    #[serde(rename = "linux-x86_64")]
    LinuxX86_64,
}

/// The executable format family a platform runs natively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabOs {
    /// Mach-O, thin or universal.
    Darwin,
    /// ELF.
    Linux,
}

impl TabPlatform {
    /// Every platform, in documentation order.
    pub const ALL: [TabPlatform; 3] = [
        TabPlatform::DarwinAarch64,
        TabPlatform::DarwinX86_64,
        TabPlatform::LinuxX86_64,
    ];

    /// The platform this Cadencr was built for; `None` where tab backends are
    /// not supported (Windows, Linux on ARM, …).
    pub fn current() -> Option<TabPlatform> {
        crate::current_binary_target().and_then(TabPlatform::parse)
    }

    /// The manifest key, e.g. `darwin-aarch64`.
    pub const fn as_str(self) -> &'static str {
        match self {
            TabPlatform::DarwinAarch64 => "darwin-aarch64",
            TabPlatform::DarwinX86_64 => "darwin-x86_64",
            TabPlatform::LinuxX86_64 => "linux-x86_64",
        }
    }

    /// The platform a manifest key names, matched exactly.
    pub fn parse(key: &str) -> Option<TabPlatform> {
        Self::ALL
            .into_iter()
            .find(|platform| platform.as_str() == key)
    }

    pub const fn os(self) -> TabOs {
        match self {
            TabPlatform::DarwinAarch64 | TabPlatform::DarwinX86_64 => TabOs::Darwin,
            TabPlatform::LinuxX86_64 => TabOs::Linux,
        }
    }

    /// `darwin-aarch64, darwin-x86_64, linux-x86_64`, for messages.
    pub fn list() -> String {
        Self::ALL.map(TabPlatform::as_str).join(", ")
    }
}

impl fmt::Display for TabPlatform {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_and_serialize_as_themselves() {
        for platform in TabPlatform::ALL {
            assert_eq!(TabPlatform::parse(platform.as_str()), Some(platform));
            assert_eq!(
                serde_json::to_value(platform).unwrap(),
                serde_json::Value::String(platform.as_str().into())
            );
            assert_eq!(
                serde_json::from_value::<TabPlatform>(platform.as_str().into()).unwrap(),
                platform
            );
        }
        for unknown in [
            "windows-x86_64",
            "linux-aarch64",
            "Darwin-aarch64",
            "macos",
            "",
        ] {
            assert_eq!(TabPlatform::parse(unknown), None, "{unknown}");
            assert!(serde_json::from_value::<TabPlatform>(unknown.into()).is_err());
        }
        assert_eq!(TabPlatform::DarwinX86_64.os(), TabOs::Darwin);
        assert_eq!(TabPlatform::LinuxX86_64.os(), TabOs::Linux);
    }

    #[test]
    fn the_current_platform_matches_the_build_target() {
        let expected = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => Some(TabPlatform::DarwinAarch64),
            ("macos", "x86_64") => Some(TabPlatform::DarwinX86_64),
            ("linux", "x86_64") => Some(TabPlatform::LinuxX86_64),
            _ => None,
        };
        assert_eq!(TabPlatform::current(), expected);
    }
}
