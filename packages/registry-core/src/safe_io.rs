use std::path::Path;

/// Largest PEM key file (public or private) the registry reads.
pub(crate) const KEY_LIMIT: u64 = 16 * 1024;

/// The bounded, symlink- and FIFO-refusing reader shared with plugin
/// inspection (`cadencr_plugin_core::read_regular_bounded`).
pub(crate) fn read_bounded_regular(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    cadencr_plugin_core::read_regular_bounded(path, limit)
}
