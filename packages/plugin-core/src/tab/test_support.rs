use serde_json::{json, Value};

use super::issues::TabIssue;
use super::manifest::TabManifest;
use super::platform::TabPlatform;

/// The `docs/CUSTOM_TABS.md` §3 example with `overrides` merged over its top level
/// (a `null` override removes the key).
pub fn manifest_json(overrides: Value) -> Value {
    manifest_json_for("changed-files-graph", overrides)
}

/// [`manifest_json`] for tab `id`.
pub fn manifest_json_for(id: &str, overrides: Value) -> Value {
    let mut base = json!({
        "schema_version": 1,
        "kind": "tab",
        "id": id,
        "name": "Changed files graph",
        "version": "0.1.0",
        "description": "Graph of the files this feature changed.",
        "icon": "icon.svg",
        "api_version": 1,
        "entry": "dist/index.html",
        "tab": { "label": "Graph" },
        "permissions": ["features:read", "git:read"],
        "network": {
            "allowed_origins": ["https://gitlab.example.com"],
            "reasoning": "Reads merge-request pipelines from the team GitLab."
        },
        "configuration": [
            { "key": "gitlab_url", "type": "string", "label": "GitLab URL", "scope": "global" },
            { "key": "gitlab_token", "type": "secret", "label": "Access token", "scope": "global" },
            { "key": "group", "type": "select", "label": "Grouping", "scope": "project",
              "options": ["directory", "extension"], "default": "directory" }
        ]
    });
    let object = base.as_object_mut().unwrap();
    for (key, value) in overrides.as_object().unwrap() {
        if value.is_null() {
            object.remove(key);
        } else {
            object.insert(key.clone(), value.clone());
        }
    }
    base
}

pub fn manifest(overrides: Value) -> TabManifest {
    serde_json::from_value(manifest_json(overrides)).unwrap()
}

pub fn codes(issues: &[TabIssue]) -> Vec<&'static str> {
    issues.iter().map(|issue| issue.code.as_str()).collect()
}

/// One image of a [`mach_o`] file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachOSlice {
    /// arm64 with an `LC_CODE_SIGNATURE`, as the linker writes it.
    Arm64Signed,
    /// arm64 without one: the kernel would kill it.
    Arm64Unsigned,
    X86_64,
}

/// A minimal Mach-O file (header and load commands only, never runnable): a
/// thin image for one slice, a universal file for several.
pub fn mach_o(slices: &[MachOSlice]) -> Vec<u8> {
    if let [slice] = slices {
        return thin_mach_o(*slice);
    }
    let images: Vec<Vec<u8>> = slices.iter().map(|slice| thin_mach_o(*slice)).collect();
    let mut file = Vec::new();
    file.extend_from_slice(&0xcafe_babe_u32.to_be_bytes());
    file.extend_from_slice(&(images.len() as u32).to_be_bytes());
    let mut offset = 8 + 20 * images.len();
    let mut entries = Vec::new();
    for (slice, image) in slices.iter().zip(&images) {
        for field in [cpu_type(*slice), 0, offset as u32, image.len() as u32, 0] {
            entries.extend_from_slice(&field.to_be_bytes());
        }
        offset += image.len();
    }
    file.extend_from_slice(&entries);
    images
        .iter()
        .for_each(|image| file.extend_from_slice(image));
    file
}

/// The smallest file [`crate::tab::check_backend_binary`] accepts as native
/// for `platform` (signed arm64 Mach-O, x86_64 Mach-O, or an x86_64 ELF
/// header).
pub fn native_executable(platform: TabPlatform) -> Vec<u8> {
    match platform {
        TabPlatform::DarwinAarch64 => mach_o(&[MachOSlice::Arm64Signed]),
        TabPlatform::DarwinX86_64 => mach_o(&[MachOSlice::X86_64]),
        TabPlatform::LinuxX86_64 => elf(62),
    }
}

/// A 64-bit little-endian ELF executable header (64 bytes, never runnable)
/// for `e_machine` `machine` (62 is x86_64, 183 aarch64).
pub fn elf(machine: u16) -> Vec<u8> {
    let mut header = vec![0u8; 64];
    header[..8].copy_from_slice(b"\x7fELF\x02\x01\x01\x00");
    header[16..18].copy_from_slice(&2u16.to_le_bytes());
    header[18..20].copy_from_slice(&machine.to_le_bytes());
    header[20..24].copy_from_slice(&1u32.to_le_bytes());
    header
}

fn cpu_type(slice: MachOSlice) -> u32 {
    match slice {
        MachOSlice::Arm64Signed | MachOSlice::Arm64Unsigned => 0x0100_000c,
        MachOSlice::X86_64 => 0x0100_0007,
    }
}

fn thin_mach_o(slice: MachOSlice) -> Vec<u8> {
    // LC_UUID (24 bytes), then LC_CODE_SIGNATURE (16 bytes) when signed.
    let mut commands: Vec<u32> = vec![0x1b, 24, 0, 0, 0, 0];
    if slice == MachOSlice::Arm64Signed {
        commands.extend([0x1d, 16, 0, 0]);
    }
    let count = if slice == MachOSlice::Arm64Signed {
        2
    } else {
        1
    };
    let size = (commands.len() * 4) as u32;
    let header = [0xfeed_facf, cpu_type(slice), 0, 2, count, size, 0, 0];
    header
        .iter()
        .chain(&commands)
        .flat_map(|word: &u32| word.to_le_bytes())
        .collect()
}
