use std::path::PathBuf;

/// Directory holding the remote-access cert, key, and device-token pepper.
/// Lives next to the database under the per-user data dir (`~/.cadencr/remote`
/// on macOS, `$XDG_DATA_HOME/cadencr/remote` on Linux). Fail closed when that
/// dir cannot be resolved rather than placing persistent credentials in a
/// working directory or predictable shared temporary path.
pub fn remote_data_dir() -> anyhow::Result<PathBuf> {
    remote_data_dir_from(crate::shared::app_paths::data_dir())
}

fn remote_data_dir_from(data_dir: Result<PathBuf, String>) -> anyhow::Result<PathBuf> {
    data_dir.map(|dir| dir.join("remote")).map_err(|error| {
        anyhow::anyhow!("cannot resolve data directory for remote credentials: {error}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_data_dir_fails_closed() {
        assert!(remote_data_dir_from(Err("no home".into())).is_err());
    }

    #[test]
    fn credentials_live_under_the_data_dir() {
        let dir = remote_data_dir_from(Ok(PathBuf::from("/data/cadencr"))).unwrap();
        assert_eq!(dir, PathBuf::from("/data/cadencr/remote"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_the_legacy_location() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            remote_data_dir().unwrap(),
            home.join(".cadencr").join("remote")
        );
    }
}
