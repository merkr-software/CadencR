//! Cross-process checkpoints for fake providers. See fixtures/provider_gate.py.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// One in-flight checkpoint per name and working directory. Wait for provider
/// progress after release before rearming the same name.
pub struct ProviderGate {
    armed: PathBuf,
    reached: PathBuf,
}

impl ProviderGate {
    pub fn arm(cwd: &Path, name: &str) -> Self {
        let armed = cwd.join(format!(".provider-{name}.armed"));
        let reached = armed.with_extension("reached");
        assert!(!reached.exists(), "checkpoint still in use: {reached:?}");
        fs::File::create_new(&armed).expect("arm provider checkpoint");
        Self { armed, reached }
    }

    pub async fn wait(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !self.reached.try_exists().expect("read provider checkpoint") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("provider did not reach {:?}", self.reached));
    }

    pub fn release(self) {
        fs::remove_file(&self.reached).expect("release reached provider checkpoint");
    }
}

impl Drop for ProviderGate {
    fn drop(&mut self) {
        // Cancel an unclaimed gate or unblock a provider after a test panic.
        // Remove the armed marker first so an atomic claim cannot race cleanup.
        for path in [&self.armed, &self.reached] {
            match fs::remove_file(path) {
                Err(error) if error.kind() != ErrorKind::NotFound => {
                    eprintln!("could not clean up provider checkpoint {path:?}: {error}");
                }
                _ => {}
            }
        }
    }
}
