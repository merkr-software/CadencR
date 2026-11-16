//! Where OpenCode keeps its session databases.
//!
//! OpenCode resolves its data dir through `xdg-basedir` on every platform:
//! `$XDG_DATA_HOME/opencode` when that variable is set to an absolute path,
//! otherwise `~/.local/share/opencode` (macOS included).

use std::ffi::OsString;
use std::path::PathBuf;

/// OpenCode's data directory for the current environment.
pub(crate) fn opencode_data_dir() -> Option<PathBuf> {
    resolve_opencode_data_dir(std::env::var_os("XDG_DATA_HOME"), dirs::home_dir())
}

fn resolve_opencode_data_dir(
    xdg_data_home: Option<OsString>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    let xdg = xdg_data_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let base = xdg.or_else(|| home.map(|home| home.join(".local").join("share")))?;
    Some(base.join("opencode"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdg_data_home_wins_when_absolute() {
        let dir = resolve_opencode_data_dir(Some("/data".into()), Some("/home/u".into()));
        assert_eq!(dir, Some(PathBuf::from("/data/opencode")));
    }

    #[test]
    fn falls_back_to_local_share_for_unset_or_relative_xdg() {
        let expected = Some(PathBuf::from("/home/u/.local/share/opencode"));
        assert_eq!(
            resolve_opencode_data_dir(None, Some("/home/u".into())),
            expected
        );
        assert_eq!(
            resolve_opencode_data_dir(Some("relative".into()), Some("/home/u".into())),
            expected
        );
        assert_eq!(resolve_opencode_data_dir(None, None), None);
    }
}
