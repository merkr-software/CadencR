//! Alacritty's own config search order (Unix), so Cadencr reads the file the
//! user's Alacritty actually loads:
//!
//! 1. `$XDG_CONFIG_HOME/alacritty/alacritty.toml`
//! 2. `$XDG_CONFIG_HOME/alacritty.toml`
//! 3. `$HOME/.config/alacritty/alacritty.toml`
//! 4. `$HOME/.alacritty.toml`
//! 5. `/etc/alacritty/alacritty.toml`
//!
//! The first existing file wins. When none exists we still return the primary
//! location (1, or 3 without `$XDG_CONFIG_HOME`) so the watcher can notice the
//! user creating it.

use std::path::{Path, PathBuf};

const SYSTEM_CONFIG: &str = "/etc/alacritty/alacritty.toml";

pub fn config_path() -> Option<PathBuf> {
    resolve_config_path(
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        dirs::home_dir(),
        |path| path.is_file(),
    )
}

fn resolve_config_path(
    xdg_config_home: Option<PathBuf>,
    home: Option<PathBuf>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let candidates = candidates(xdg_config_home, home);
    candidates
        .iter()
        .find(|path| exists(path))
        .or_else(|| candidates.iter().find(|path| !path.starts_with("/etc")))
        .cloned()
}

fn candidates(xdg_config_home: Option<PathBuf>, home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::with_capacity(5);
    if let Some(xdg) = xdg_config_home.filter(|path| path.is_absolute()) {
        paths.push(xdg.join("alacritty").join("alacritty.toml"));
        paths.push(xdg.join("alacritty.toml"));
    }
    if let Some(home) = home {
        paths.push(
            home.join(".config")
                .join("alacritty")
                .join("alacritty.toml"),
        );
        paths.push(home.join(".alacritty.toml"));
    }
    paths.push(PathBuf::from(SYSTEM_CONFIG));
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> Option<PathBuf> {
        Some(PathBuf::from("/home/u"))
    }

    #[test]
    fn defaults_to_home_config_when_nothing_exists() {
        let path = resolve_config_path(None, home(), |_| false);
        assert_eq!(
            path,
            Some(PathBuf::from("/home/u/.config/alacritty/alacritty.toml"))
        );
    }

    #[test]
    fn xdg_config_home_is_the_primary_location() {
        let path = resolve_config_path(Some("/cfg".into()), home(), |_| false);
        assert_eq!(path, Some(PathBuf::from("/cfg/alacritty/alacritty.toml")));
    }

    #[test]
    fn first_existing_candidate_wins() {
        let legacy = PathBuf::from("/home/u/.alacritty.toml");
        let path = resolve_config_path(Some("/cfg".into()), home(), |p| p == legacy);
        assert_eq!(path, Some(legacy));
        let flat = PathBuf::from("/cfg/alacritty.toml");
        let path = resolve_config_path(Some("/cfg".into()), home(), |p| p == flat);
        assert_eq!(path, Some(flat));
    }

    #[test]
    fn system_config_is_read_but_never_the_fallback() {
        let path = resolve_config_path(None, home(), |p| p == Path::new(SYSTEM_CONFIG));
        assert_eq!(path, Some(PathBuf::from(SYSTEM_CONFIG)));
        assert_eq!(resolve_config_path(None, None, |_| false), None);
    }

    #[test]
    fn relative_xdg_config_home_is_ignored() {
        let path = resolve_config_path(Some("cfg".into()), home(), |_| false);
        assert_eq!(
            path,
            Some(PathBuf::from("/home/u/.config/alacritty/alacritty.toml"))
        );
    }
}
