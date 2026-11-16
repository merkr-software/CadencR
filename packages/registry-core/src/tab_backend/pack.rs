//! `cadencr registry pack-tab-backend`: one platform's executable, packed
//! alone, so a CI matrix can build and pack each platform on its own runner.
use std::path::{Path, PathBuf};

use cadencr_plugin_core::tab::{check_backend_bytes, resolve_backend_binary, TabPlatform};
use serde::Serialize;

use super::{binding::check_cmd_location, invalid, MAX_TAB_BACKEND_EXECUTABLE_BYTES};
use crate::digest::sha256_hex;
use crate::RegistryError;

#[derive(bon::Builder)]
pub struct PackTabBackendRequest<'a> {
    /// The tab folder: its `tab.json` names the executable per platform.
    pub directory: &'a Path,
    /// The `tab.json` `backend.binary` key to pack.
    pub target: TabPlatform,
    /// A new `.tar.gz` path outside the tab folder.
    pub output: &'a Path,
}

/// What to copy into `tab.distribution.binary.<target>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackedTabBackend {
    pub target: TabPlatform,
    pub archive: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub cmd: String,
    pub executable_sha256: String,
    pub executable_size: u64,
}

/// Pack the executable `tab.json` declares for `target` into a deterministic
/// ustar+gzip holding that one file at its manifest path, mode 0755. The
/// executable must be a native, regular file inside the folder (not reached
/// through a symlink), at most 128 MiB, outside the web root; the archive at
/// most 64 MiB. Nothing is executed.
pub fn pack_tab_backend(
    request: PackTabBackendRequest<'_>,
) -> Result<PackedTabBackend, RegistryError> {
    crate::archive::validate_output_name(request.output)?;
    let platform = request.target;
    let root = request
        .directory
        .canonicalize()
        .map_err(|error| invalid(format!("cannot resolve the tab folder: {error}")))?;
    let (manifest, _) = crate::tab_archive::read_folder_manifest(&root)?;
    let backend = manifest.backend.as_ref().ok_or_else(|| {
        invalid(
            "tab.json declares no `backend`; only a tab with a native backend has backend archives",
        )
    })?;
    let cmd = backend.binary_for(platform).ok_or_else(|| {
        invalid(format!(
            "tab.json backend.binary declares no executable for {platform}"
        ))
    })?;
    if manifest.entry.rsplit_once('/').is_none() {
        return Err(invalid(
            "distributed entry requires a compiled web directory",
        ));
    }
    check_cmd_location(&manifest, cmd)?;
    let executable = read_executable(&root, cmd, platform)?;
    let built =
        crate::archive::write::single_executable_archive(cmd, &executable, &root, request.output)?;
    Ok(PackedTabBackend {
        target: platform,
        archive: std::path::absolute(request.output)
            .map_err(|error| invalid(format!("cannot resolve the output path: {error}")))?,
        sha256: built.sha256,
        size: built.size,
        cmd: cmd.into(),
        executable_sha256: sha256_hex(&executable),
        executable_size: executable.len() as u64,
    })
}

/// The executable's bytes, checked native once read so the archive holds
/// exactly the bytes that passed.
fn read_executable(
    root: &Path,
    cmd: &str,
    platform: TabPlatform,
) -> Result<Vec<u8>, RegistryError> {
    let describe = |problem: &dyn std::fmt::Display| {
        invalid(format!("backend binary `{cmd}` for {platform} {problem}"))
    };
    let path = resolve_backend_binary(root, cmd).map_err(|problem| describe(&problem))?;
    if path != root.join(cmd) {
        return Err(describe(
            &"is reached through a symlink; the archive needs the real file at that path",
        ));
    }
    let executable = crate::safe_io::read_bounded_regular(&path, MAX_TAB_BACKEND_EXECUTABLE_BYTES)
        .map_err(|error| describe(&format!("cannot be packed: {error} (the limit is 128 MiB)")))?;
    check_backend_bytes(&executable, platform).map_err(|problem| describe(&problem))?;
    Ok(executable)
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use cadencr_plugin_core::tab::test_support::{mach_o, native_executable, MachOSlice};
    use serde_json::json;

    use super::super::tests::{cmd, manifest_json};
    use super::super::{read_tab_backend_archive, SignedTabBinary};
    use super::*;

    /// A tab folder with every platform's executable built.
    fn folder() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("port-monitor");
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.html"), "<html></html>").unwrap();
        write_manifest(&root, &manifest_json());
        for platform in TabPlatform::ALL {
            write_executable(&root, &cmd(platform.as_str()), &native_executable(platform));
        }
        (temp, root)
    }

    fn write_manifest(root: &Path, manifest: &serde_json::Value) {
        std::fs::write(root.join("tab.json"), serde_json::to_vec(manifest).unwrap()).unwrap();
    }

    fn write_executable(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn pack(root: &Path, target: TabPlatform, output: &Path) -> Result<PackedTabBackend, String> {
        pack_tab_backend(
            PackTabBackendRequest::builder()
                .directory(root)
                .target(target)
                .output(output)
                .build(),
        )
        .map_err(|error| error.to_string())
    }

    #[test]
    fn packs_one_deterministic_executable_entry_per_platform() {
        let (temp, root) = folder();
        for platform in TabPlatform::ALL {
            let first = pack(
                &root,
                platform,
                &temp.path().join(format!("{platform}-a.tar.gz")),
            )
            .unwrap();
            let second = pack(
                &root,
                platform,
                &temp.path().join(format!("{platform}-b.tar.gz")),
            )
            .unwrap();
            assert_eq!(first.sha256, second.sha256);
            assert_eq!(first.cmd, cmd(platform.as_str()));
            assert_eq!(first.target, platform);
            let bytes = std::fs::read(&first.archive).unwrap();
            assert_eq!(bytes.len() as u64, first.size);
            let signed = SignedTabBinary {
                archive: String::new(),
                sha256: first.sha256.clone(),
                size: first.size,
                cmd: first.cmd.clone(),
                executable_sha256: first.executable_sha256.clone(),
                executable_size: first.executable_size,
            };
            assert_eq!(
                read_tab_backend_archive(&bytes, platform, &signed).unwrap(),
                native_executable(platform)
            );
            // One ustar entry: 0755, owner 0:0, mtime 0.
            let mut tar = Vec::new();
            std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&bytes[..]), &mut tar)
                .unwrap();
            assert_eq!(&tar[100..108], b"0000755\0");
            assert_eq!(&tar[108..116], b"0000000\0");
            assert_eq!(&tar[116..124], b"0000000\0");
            assert_eq!(&tar[136..148], b"00000000000\0");
            assert_eq!(tar[156], b'0');
        }
    }

    #[test]
    fn refuses_executables_the_platform_would_not_run() {
        let (temp, root) = folder();
        let output = |name: &str| temp.path().join(format!("{name}.tar.gz"));
        write_executable(&root, &cmd("linux-x86_64"), b"#!/bin/sh\necho hi\n");
        assert!(pack(&root, TabPlatform::LinuxX86_64, &output("script"))
            .unwrap_err()
            .contains("not a script"));
        write_executable(
            &root,
            &cmd("darwin-x86_64"),
            &native_executable(TabPlatform::LinuxX86_64),
        );
        assert!(pack(&root, TabPlatform::DarwinX86_64, &output("elf"))
            .unwrap_err()
            .contains("not a native executable for darwin-x86_64"));
        write_executable(
            &root,
            &cmd("darwin-aarch64"),
            &mach_o(&[MachOSlice::Arm64Unsigned]),
        );
        assert!(pack(&root, TabPlatform::DarwinAarch64, &output("unsigned"))
            .unwrap_err()
            .contains("unsigned arm64"));
        std::fs::set_permissions(
            root.join(cmd("darwin-aarch64")),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(pack(&root, TabPlatform::DarwinAarch64, &output("plain"))
            .unwrap_err()
            .contains("not executable"));
        for name in ["script", "elf", "unsigned", "plain"] {
            assert!(!output(name).exists(), "{name}");
        }
    }

    #[test]
    fn refuses_symlinks_bad_targets_outputs_and_ui_only_tabs() {
        let (temp, root) = folder();
        let output = |name: &str| temp.path().join(format!("{name}.tar.gz"));
        let linux = root.join(cmd("linux-x86_64"));
        std::fs::rename(&linux, root.join("bin/real")).unwrap();
        std::os::unix::fs::symlink(root.join("bin/real"), &linux).unwrap();
        assert!(pack(&root, TabPlatform::LinuxX86_64, &output("link"))
            .unwrap_err()
            .contains("symlink"));
        std::fs::remove_file(&linux).unwrap();
        std::os::unix::fs::symlink(root.join("bin"), root.join("bin-alias")).unwrap();
        let mut aliased = manifest_json();
        aliased["backend"]["binary"]["linux-x86_64"] = json!("bin-alias/real");
        write_manifest(&root, &aliased);
        assert!(pack(&root, TabPlatform::LinuxX86_64, &output("alias"))
            .unwrap_err()
            .contains("symlink"));
        assert!(pack(
            &root,
            TabPlatform::DarwinAarch64,
            &root.join("inside.tar.gz")
        )
        .unwrap_err()
        .contains("inside staging"));
        assert!(pack(
            &root,
            TabPlatform::DarwinAarch64,
            &temp.path().join("out.zip")
        )
        .unwrap_err()
        .contains(".tar.gz"));
        let mut web_root = manifest_json();
        web_root["backend"]["binary"]["darwin-aarch64"] = json!("dist/port-monitor");
        write_manifest(&root, &web_root);
        assert!(pack(&root, TabPlatform::DarwinAarch64, &output("web"))
            .unwrap_err()
            .contains("outside tab.json"));
        let mut fewer = manifest_json();
        fewer["backend"]["binary"]
            .as_object_mut()
            .unwrap()
            .remove("darwin-x86_64");
        write_manifest(&root, &fewer);
        assert!(pack(&root, TabPlatform::DarwinX86_64, &output("missing"))
            .unwrap_err()
            .contains("no executable for darwin-x86_64"));
        let mut ui_only = manifest_json();
        ui_only.as_object_mut().unwrap().remove("backend");
        write_manifest(&root, &ui_only);
        assert!(pack(&root, TabPlatform::DarwinAarch64, &output("ui"))
            .unwrap_err()
            .contains("declares no `backend`"));
    }
}
