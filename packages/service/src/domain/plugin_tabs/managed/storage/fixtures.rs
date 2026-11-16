//! Signed archive fixtures shared by the managed tab unit tests.
use super::*;
use crate::domain::agents::providers::installed::managed::trust::{
    ManagedTrustStore, TrustedIndexKey,
};
use base64::Engine as _;
use cadencr_plugin_core::tab::TabPlatform;
use ed25519_dalek::{Signer as _, SigningKey};

pub(in crate::domain::plugin_tabs) fn fixture(
    root: &Path,
) -> (
    Receipt,
    Vec<u8>,
    BTreeMap<String, Vec<u8>>,
    ManagedTrustStore,
) {
    fixture_revision(root, 0)
}

pub(in crate::domain::plugin_tabs) fn fixture_revision(
    root: &Path,
    revision: usize,
) -> (
    Receipt,
    Vec<u8>,
    BTreeMap<String, Vec<u8>>,
    ManagedTrustStore,
) {
    fixture_for().root(root).revision(revision).call()
}

#[bon::builder]
pub(in crate::domain::plugin_tabs::managed) fn fixture_for(
    root: &Path,
    #[builder(default = "graph")] id: &str,
    #[builder(default)] revision: usize,
    maximum: Option<&str>,
) -> (
    Receipt,
    Vec<u8>,
    BTreeMap<String, Vec<u8>>,
    ManagedTrustStore,
) {
    let built = build(root, id, revision, maximum, None);
    (built.receipt, built.archive, built.files, built.trust)
}

/// A signed backend tab: its web archive plus one platform's backend archive.
pub(in crate::domain::plugin_tabs) struct BackendFixture {
    pub receipt: Receipt,
    pub archive: Vec<u8>,
    pub files: BTreeMap<String, Vec<u8>>,
    pub trust: ManagedTrustStore,
    pub backend_archive: Vec<u8>,
    pub executable: Vec<u8>,
    pub cmd: String,
}
impl BackendFixture {
    pub fn payload(&self) -> BackendPayload<'_> {
        BackendPayload {
            archive: &self.backend_archive,
            archive_sha256: io::digest(&self.backend_archive),
            executable: &self.executable,
            executable_sha256: io::digest(&self.executable),
            cmd: &self.cmd,
        }
    }
    /// Commit this revision, its backend included, under `root`.
    pub fn commit(&self, root: &Path, activation: Activation) -> Result<(), AppError> {
        commit_revision()
            .root(root)
            .receipt(&self.receipt)
            .archive(&self.archive)
            .files(&self.files)
            .backend(self.payload())
            .activation(activation)
            .call()
    }
}

/// Revision `revision` of a backend tab, its stand-in binary distinct per
/// revision (so each is a binary-only update of the previous one).
pub(in crate::domain::plugin_tabs) fn backend_revision(
    root: &Path,
    revision: usize,
) -> BackendFixture {
    let mut executable = cadencr_plugin_core::tab::test_support::native_executable(
        TabPlatform::current().expect("tests run where tab backends are supported"),
    );
    executable.extend_from_slice(format!("build {revision}").as_bytes());
    backend_fixture()
        .root(root)
        .revision(revision)
        .executable(executable)
        .call()
}

/// Commit and activate a UI-only revision.
pub fn commit(
    root: &Path,
    receipt: &Receipt,
    archive: &[u8],
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), AppError> {
    commit_revision()
        .root(root)
        .receipt(receipt)
        .archive(archive)
        .files(files)
        .activation(Activation::Activate)
        .call()
}

/// A platform tab backends support that is not the one tests run on.
pub(in crate::domain::plugin_tabs) fn other_platform() -> TabPlatform {
    TabPlatform::ALL
        .into_iter()
        .find(|platform| Some(*platform) != TabPlatform::current())
        .expect("more than one tab platform")
}

/// A backend tab shipping `executable` for `platform` (by default this one)
/// and, signed beside it, a stand-in binary for every platform in `also`.
/// The default executable is the native fixture backend, or a stand-in for
/// another platform.
#[bon::builder]
pub(in crate::domain::plugin_tabs) fn backend_fixture(
    root: &Path,
    #[builder(default = "graph")] id: &str,
    #[builder(default)] revision: usize,
    executable: Option<Vec<u8>>,
    platform: Option<TabPlatform>,
    #[builder(default)] also: Vec<TabPlatform>,
) -> BackendFixture {
    let platform = platform
        .or_else(TabPlatform::current)
        .expect("tests run where tab backends are supported");
    let executable = executable.unwrap_or_else(|| {
        if Some(platform) != TabPlatform::current() {
            return cadencr_plugin_core::tab::test_support::native_executable(platform);
        }
        let path = crate::domain::plugin_tabs::native_tab_backend::install(
            &root.join("native"),
            "backend",
        );
        std::fs::read(path).unwrap()
    });
    let mut binaries = vec![(platform, executable.clone())];
    for other in also {
        binaries.push((
            other,
            cadencr_plugin_core::tab::test_support::native_executable(other),
        ));
    }
    let built = build(root, id, revision, None, Some(&binaries));
    let (backend_archive, cmd) = built.backends.into_iter().next().unwrap();
    BackendFixture {
        receipt: built.receipt,
        archive: built.archive,
        files: built.files,
        trust: built.trust,
        backend_archive,
        executable,
        cmd,
    }
}

struct Built {
    receipt: Receipt,
    archive: Vec<u8>,
    files: BTreeMap<String, Vec<u8>>,
    trust: ManagedTrustStore,
    /// `(archive, cmd)` per binary, in the order given.
    backends: Vec<(Vec<u8>, String)>,
}

fn build(
    root: &Path,
    id: &str,
    revision: usize,
    maximum: Option<&str>,
    binaries: Option<&[(TabPlatform, Vec<u8>)]>,
) -> Built {
    let version = format!("1.0.{revision}");
    let stage = root.join("input");
    std::fs::create_dir_all(stage.join("dist")).unwrap();
    let mut manifest = serde_json::json!({"schema_version":1,"kind":"tab","id":id,"name":"Graph","version":version,"api_version":1,"entry":"dist/index.html","permissions":["git:read"]});
    let cmd = |platform: TabPlatform| format!("bin/{platform}/{id}");
    if let Some(binaries) = binaries {
        let binary: serde_json::Map<String, serde_json::Value> = binaries
            .iter()
            .map(|(platform, _)| (platform.to_string(), serde_json::json!(cmd(*platform))))
            .collect();
        manifest["backend"] =
            serde_json::json!({"protocol":1,"reasoning":"Reads the graph.","binary":binary});
    }
    std::fs::write(
        stage.join("tab.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(stage.join("dist/index.html"), "<html>Graph</html>").unwrap();
    let output = root.join("tab.tar.gz");
    let packed = cadencr_registry_core::pack_tab(
        cadencr_registry_core::PackTabRequest::builder()
            .directory(&stage)
            .output(&output)
            .build(),
    )
    .unwrap();
    let release = "https://github.com/acme/tabs/releases/download/v1.0.0";
    let mut tab = serde_json::json!({"id":id,"name":"Graph","description":"A graph","version":version,"api_version":1,"license":"MIT","repository":"https://github.com/acme/tabs","distribution":{"archive":format!("{release}/tab.tar.gz"),"sha256":packed.sha256}});
    let mut backends = Vec::new();
    if let Some(binaries) = binaries {
        let folder = root.join("backend-input");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::copy(stage.join("tab.json"), folder.join("tab.json")).unwrap();
        let mut signed = serde_json::Map::new();
        for (platform, bytes) in binaries {
            let path = folder.join(cmd(*platform));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            let output = root.join(format!("backend-{platform}.tar.gz"));
            let packed = cadencr_registry_core::pack_tab_backend(
                cadencr_registry_core::PackTabBackendRequest::builder()
                    .directory(&folder)
                    .target(*platform)
                    .output(&output)
                    .build(),
            )
            .unwrap();
            signed.insert(platform.to_string(), serde_json::json!({"archive":format!("{release}/backend-{platform}.tar.gz"),"sha256":packed.sha256,"size":packed.size,"cmd":packed.cmd,"executable_sha256":packed.executable_sha256,"executable_size":packed.executable_size}));
            backends.push((std::fs::read(output).unwrap(), packed.cmd));
        }
        tab["backend"] = serde_json::json!({"protocol":1,"reasoning":"Reads the graph."});
        tab["distribution"]["binary"] = serde_json::Value::Object(signed);
    }
    let now = chrono::Utc::now();
    let mut payload = serde_json::json!({"schema_version":2,"generated_at":(now-chrono::Duration::minutes(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"expires_at":(now+chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"packages":[{"kind":"tab","package":{"tab":tab,"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}}}]});
    if let Some(maximum) = maximum {
        payload["packages"][0]["package"]["host"]["compatibility"]["max_app_version"] =
            serde_json::json!(maximum);
    }
    let (index, trust) = sign(&payload);
    let archive = std::fs::read(output).unwrap();
    let files = cadencr_registry_core::read_tab_archive_bytes(&archive).unwrap();
    Built {
        receipt: Receipt {
            index,
            id: id.into(),
            version,
            platform: binaries.map(|binaries| binaries[0].0),
        },
        archive,
        files,
        trust,
        backends,
    }
}

/// The signed catalog envelope of `payload`, under the test key.
pub(in crate::domain::plugin_tabs) fn sign(
    payload: &serde_json::Value,
) -> (SignedMixedCatalog, ManagedTrustStore) {
    let key = SigningKey::from_bytes(&[37; 32]);
    let bytes = cadencr_registry_core::canonical_json_bytes(payload);
    let index = serde_json::from_value(serde_json::json!({"signed":payload,"signature":{"algorithm":"ed25519","key_id":"tab-test","value":base64::engine::general_purpose::STANDARD.encode(key.sign(&bytes).to_bytes())}})).unwrap();
    (index, trust())
}

/// The store trusting the fixture key alone.
pub(in crate::domain::plugin_tabs) fn trust() -> ManagedTrustStore {
    let key = SigningKey::from_bytes(&[37; 32]);
    ManagedTrustStore::new([
        TrustedIndexKey::new("tab-test", key.verifying_key().to_bytes()).unwrap(),
    ])
}

/// One signed catalog listing every package of `indexes`, so tests can
/// install and then update without two catalogs signed in the same second
/// (an equivocation the catalog high-water mark rejects).
pub(in crate::domain::plugin_tabs) fn merged(
    indexes: &[&SignedMixedCatalog],
) -> SignedMixedCatalog {
    let mut payload = serde_json::to_value(&indexes[0].signed).unwrap();
    payload["packages"] = serde_json::Value::Array(
        indexes
            .iter()
            .flat_map(|index| index.signed.packages.clone())
            .collect(),
    );
    sign(&payload).0
}

/// Give the owner write permission back on `path` and everything under it,
/// as a user editing a sealed revision by hand would (`chmod -R u+w`).
pub(in crate::domain::plugin_tabs) fn unseal_tree(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let meta = path.symlink_metadata().unwrap();
        if meta.file_type().is_symlink() {
            return;
        }
        let mode = meta.permissions().mode();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o200)).unwrap();
        if meta.is_dir() {
            for entry in std::fs::read_dir(path).unwrap() {
                unseal_tree(&entry.unwrap().path());
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}
