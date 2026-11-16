//! Deterministic synthetic Ed25519 key pairs; never release credentials.
use std::path::{Path, PathBuf};

pub const PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";
pub const PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n";
/// A second pair: someone else's key.
pub const OTHER_PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI\n-----END PRIVATE KEY-----\n";
pub const OTHER_PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE5j2LG0aRXxRumpLXz29L2n8qTIWIY3ImX5Ba9F9k8o=\n-----END PUBLIC KEY-----\n";

/// Write a pair as `<name>-private.pem` and `<name>-public.pem` in `directory`.
pub fn write(directory: &Path, name: &str, private: &str, public: &str) -> (PathBuf, PathBuf) {
    let files = (
        directory.join(format!("{name}-private.pem")),
        directory.join(format!("{name}-public.pem")),
    );
    std::fs::write(&files.0, private).unwrap();
    std::fs::write(&files.1, public).unwrap();
    files
}
