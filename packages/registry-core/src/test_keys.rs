//! Deterministic synthetic Ed25519 key pairs for unit tests; never release
//! credentials.
use std::path::{Path, PathBuf};

pub(crate) const PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";
pub(crate) const PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n";
/// A second pair, for "someone else's key" cases.
pub(crate) const OTHER_PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI\n-----END PRIVATE KEY-----\n";
pub(crate) const OTHER_PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE5j2LG0aRXxRumpLXz29L2n8qTIWIY3ImX5Ba9F9k8o=\n-----END PUBLIC KEY-----\n";

/// A key pair written as PEM files.
pub(crate) struct Keys {
    pub(crate) private: PathBuf,
    pub(crate) public: PathBuf,
}

/// Write the primary pair (`other: false`) or the second pair into `directory`.
pub(crate) fn write(directory: &Path, name: &str, other: bool) -> Keys {
    let (private, public) = if other {
        (OTHER_PRIVATE, OTHER_PUBLIC)
    } else {
        (PRIVATE, PUBLIC)
    };
    let keys = Keys {
        private: directory.join(format!("{name}-private.pem")),
        public: directory.join(format!("{name}-public.pem")),
    };
    std::fs::write(&keys.private, private).unwrap();
    std::fs::write(&keys.public, public).unwrap();
    keys
}
