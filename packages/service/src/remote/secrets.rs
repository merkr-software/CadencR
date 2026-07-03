use std::path::Path;

use anyhow::{Context, Result};
use rand::TryRng;

use super::secure_fs;

const PEPPER_LEN: usize = 32;

/// Load the device-token pepper from `<dir>/pepper`, generating 32 CSPRNG bytes
/// on first run (written `0600`). The pepper keys the device-token hash, so a
/// database leak alone yields no usable tokens without the filesystem secret.
pub fn load_or_generate_pepper(dir: &Path) -> Result<Vec<u8>> {
    let path = dir.join("pepper");
    if path.is_file() {
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        if bytes.len() == PEPPER_LEN {
            // Tighten perms on load in case the file was restored looser.
            secure_fs::ensure_owner_only(&path)?;
            return Ok(bytes);
        }
        // A truncated/corrupt pepper would silently weaken hashing — regenerate.
        // Existing device tokens become invalid (they simply re-pair), which is
        // the safe failure mode.
        tracing::warn!("remote pepper had unexpected length; regenerating");
    }

    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let mut bytes = vec![0u8; PEPPER_LEN];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS random source should be available");
    secure_fs::write_secret(&path, &bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generates_then_reloads_identical_pepper() {
        let dir = tempdir().unwrap();
        let first = load_or_generate_pepper(dir.path()).unwrap();
        assert_eq!(first.len(), PEPPER_LEN);
        let second = load_or_generate_pepper(dir.path()).unwrap();
        assert_eq!(first, second, "pepper must persist across loads");
    }
}
