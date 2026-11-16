//! A backend binary on disk: where it resolves and whether the platform runs
//! it natively.
//!
//! A backend must be a native executable shipped inside the tab folder, never
//! a script or an interpreter on `PATH`: what the user consents to is that
//! file. Recognition reads headers only (Mach-O thin or universal for Darwin,
//! ELF for Linux) — it says the OS would load the file directly, not that the
//! file is trustworthy. The code must also be for the platform's CPU: an
//! x86_64 ELF for `linux-x86_64`, an x86_64 image for `darwin-x86_64` and an
//! arm64 image for `darwin-aarch64` (a universal file must contain it). For
//! Apple silicon every arm64 image must also carry a code signature
//! ([`super::macho`]): the kernel kills it otherwise. Shared by the service
//! (before every launch), the folder inspection and `cadencr plugin validate
//! --kind tab`, so they never disagree. Marketplace digests are a separate,
//! later check.

use std::fmt;
use std::fs::Metadata;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

use super::macho::{self, Arm64Signature, Image};
use super::platform::{TabOs, TabPlatform};
use super::validate::is_clean_relative_path;

/// Bytes read from the start of a file to recognize its format.
pub const FORMAT_HEADER_BYTES: usize = 8;

/// What the first bytes of a file say it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutableFormat {
    /// Mach-O: 32- or 64-bit, either byte order, or a universal (fat) file.
    MachO,
    Elf,
    /// `#!`: an interpreter script.
    Script,
    /// Anything else, an empty file included.
    Other,
}

impl ExecutableFormat {
    /// Recognize `header`, the first [`FORMAT_HEADER_BYTES`] (or fewer) bytes.
    pub fn detect(header: &[u8]) -> ExecutableFormat {
        let magic = |bytes: &[u8]| header.starts_with(bytes);
        if magic(b"\x7fELF") {
            return ExecutableFormat::Elf;
        }
        if macho::THIN_MAGICS
            .iter()
            .any(|thin| magic(&thin.to_be_bytes()))
        {
            return ExecutableFormat::MachO;
        }
        if macho::FAT_MAGICS
            .iter()
            .any(|fat| magic(&fat.to_be_bytes()))
        {
            // Past the limit the `cafebabe` magic is a Java class file (whose
            // version sits where a universal header counts architectures).
            let arches = header
                .get(4..8)
                .map(|count| u32::from_be_bytes([count[0], count[1], count[2], count[3]]));
            if arches.is_some_and(|count| (1..=macho::MAX_FAT_ARCHES).contains(&count)) {
                return ExecutableFormat::MachO;
            }
            return ExecutableFormat::Other;
        }
        if magic(b"#!") {
            return ExecutableFormat::Script;
        }
        ExecutableFormat::Other
    }

    /// Whether `platform`'s OS loads this format directly.
    pub fn is_native_for(self, platform: TabPlatform) -> bool {
        matches!(
            (platform.os(), self),
            (TabOs::Darwin, ExecutableFormat::MachO) | (TabOs::Linux, ExecutableFormat::Elf)
        )
    }

    fn describe(self) -> &'static str {
        match self {
            ExecutableFormat::MachO => "a Mach-O (macOS) executable",
            ExecutableFormat::Elf => "an ELF (Linux) executable",
            ExecutableFormat::Script => "a `#!` script",
            ExecutableFormat::Other => "not an executable this platform recognizes",
        }
    }
}

/// Why a declared binary cannot be launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BinaryProblem {
    /// Not a normalized relative path inside the tab folder (`..`, `/abs`, …).
    InvalidPath,
    /// Nothing at that path: not built yet.
    Missing,
    /// It resolves outside the tab folder (a symlink or a moved parent).
    OutsideFolder,
    /// A directory, socket, device…
    NotRegularFile,
    /// The execute bit is not set.
    NotExecutable,
    Unreadable(String),
    /// A `#!` script: backends are native executables.
    Script,
    /// A file the platform does not run natively.
    NotNative {
        platform: TabPlatform,
        found: ExecutableFormat,
    },
    /// The platform's format, but code for another CPU (an arm64-only
    /// Mach-O for `darwin-x86_64`, an aarch64 ELF for `linux-x86_64`…);
    /// `found` names what it is built for.
    WrongCpu {
        platform: TabPlatform,
        found: String,
    },
    /// A Mach-O or ELF file whose structure cannot be read.
    Malformed(String),
    /// arm64 code without a code signature, which Apple silicon kills.
    Unsigned,
}

impl BinaryProblem {
    /// A script or a foreign format: the file is there, but is the wrong
    /// kind of file.
    pub fn is_wrong_format(&self) -> bool {
        matches!(
            self,
            BinaryProblem::Script
                | BinaryProblem::NotNative { .. }
                | BinaryProblem::WrongCpu { .. }
                | BinaryProblem::Malformed(_)
        )
    }
}

/// Each reads after the binary's path: "`bin/backend` is not executable".
impl fmt::Display for BinaryProblem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BinaryProblem::InvalidPath => {
                formatter.write_str("is not a path inside the tab folder")
            }
            BinaryProblem::Missing => {
                formatter.write_str("is not built yet: it does not exist in the tab folder")
            }
            BinaryProblem::OutsideFolder => {
                formatter.write_str("resolves outside the tab folder (through a symlink)")
            }
            BinaryProblem::NotRegularFile => formatter.write_str("is not a regular file"),
            BinaryProblem::NotExecutable => formatter.write_str("is not executable (chmod +x)"),
            BinaryProblem::Unreadable(error) => write!(formatter, "cannot be read: {error}"),
            BinaryProblem::Script => formatter
                .write_str("is a `#!` script; a backend must be a native executable, not a script"),
            BinaryProblem::NotNative { platform, found } => write!(
                formatter,
                "is {}, not a native executable for {platform}",
                found.describe()
            ),
            BinaryProblem::WrongCpu { platform, found } => write!(
                formatter,
                "is built for {found}, not for {platform} (it holds no {} code)",
                macho::cpu_name(cpu_type(*platform))
            ),
            BinaryProblem::Malformed(detail) => {
                write!(formatter, "is not a well-formed executable: {detail}")
            }
            BinaryProblem::Unsigned => formatter.write_str(
                "is an unsigned arm64 executable, which macOS kills on launch; ad-hoc sign it: \
                 codesign -s - <file> (the Rust linker does this by default)",
            ),
        }
    }
}

/// The canonical path of `relative` inside the tab folder `root` (canonical),
/// when it is a regular, executable file `platform` runs natively.
pub fn check_backend_binary(
    root: &Path,
    relative: &str,
    platform: TabPlatform,
) -> Result<PathBuf, BinaryProblem> {
    let path = resolve_backend_binary(root, relative)?;
    let mut file =
        std::fs::File::open(&path).map_err(|error| BinaryProblem::Unreadable(error.to_string()))?;
    check_native(&mut file, platform)?;
    Ok(path)
}

/// [`check_backend_binary`]'s location rules alone: the canonical path of
/// `relative`, a clean relative path resolving to a regular, executable file
/// inside `root`. Its format is not read.
pub fn resolve_backend_binary(root: &Path, relative: &str) -> Result<PathBuf, BinaryProblem> {
    if !is_clean_relative_path(relative) {
        return Err(BinaryProblem::InvalidPath);
    }
    let path = match root.join(relative).canonicalize() {
        Ok(path) => path,
        // Nothing there, or a dangling symlink: whatever it pointed at is gone.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(BinaryProblem::Missing)
        }
        Err(error) => return Err(BinaryProblem::Unreadable(error.to_string())),
    };
    if !path.starts_with(root) {
        return Err(BinaryProblem::OutsideFolder);
    }
    let metadata =
        std::fs::metadata(&path).map_err(|error| BinaryProblem::Unreadable(error.to_string()))?;
    if !metadata.is_file() {
        return Err(BinaryProblem::NotRegularFile);
    }
    if !executable_bit(&metadata) {
        return Err(BinaryProblem::NotExecutable);
    }
    Ok(path)
}

#[cfg(unix)]
fn executable_bit(metadata: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable_bit(_metadata: &Metadata) -> bool {
    true
}

/// [`check_backend_binary`]'s format checks for an executable held in
/// memory — the single entry of a marketplace backend archive, checked before
/// it is ever written to disk. Only the native-format, CPU and
/// arm64-signature rules apply: there is no folder, path or execute bit to
/// inspect.
pub fn check_backend_bytes(bytes: &[u8], platform: TabPlatform) -> Result<(), BinaryProblem> {
    check_native(&mut std::io::Cursor::new(bytes), platform)
}

/// The format, CPU and (Apple silicon) signature rules on an open file.
fn check_native(file: &mut (impl Read + Seek), platform: TabPlatform) -> Result<(), BinaryProblem> {
    check_native_format(&read_header(file)?, platform)?;
    match platform.os() {
        TabOs::Linux => match super::elf::foreign_to_x86_64(file) {
            Ok(None) => Ok(()),
            Ok(Some(found)) => Err(BinaryProblem::WrongCpu { platform, found }),
            Err(detail) => Err(BinaryProblem::Malformed(detail)),
        },
        TabOs::Darwin => check_mach_o(file, platform),
    }
}

/// A Mach-O file must hold an image for the platform's CPU; on Apple silicon
/// every arm64 image must be signed.
fn check_mach_o(file: &mut (impl Read + Seek), platform: TabPlatform) -> Result<(), BinaryProblem> {
    let images = macho::images(file).map_err(mach_o_malformed)?;
    let wanted = cpu_type(platform);
    if !images.iter().any(|image| image.cputype == wanted) {
        return Err(BinaryProblem::WrongCpu {
            platform,
            found: cpus_found(&images),
        });
    }
    if platform == TabPlatform::DarwinAarch64 {
        match macho::arm64_signature(file, &images).map_err(mach_o_malformed)? {
            Arm64Signature::Signed | Arm64Signature::NoArm64Code => {}
            Arm64Signature::Unsigned => return Err(BinaryProblem::Unsigned),
        }
    }
    Ok(())
}

/// `x86_64 + arm64`: what a Mach-O file's images are built for.
fn cpus_found(images: &[Image]) -> String {
    if images.is_empty() {
        return "no CPU (an empty universal file)".into();
    }
    images
        .iter()
        .map(|image| macho::cpu_name(image.cputype))
        .collect::<Vec<_>>()
        .join(" + ")
}

fn mach_o_malformed(detail: String) -> BinaryProblem {
    BinaryProblem::Malformed(format!("Mach-O: {detail}"))
}

/// The CPU a platform runs, as a Mach-O CPU type (Linux's x86_64 is the same
/// family).
fn cpu_type(platform: TabPlatform) -> u32 {
    match platform {
        TabPlatform::DarwinAarch64 => macho::CPU_TYPE_ARM64,
        TabPlatform::DarwinX86_64 | TabPlatform::LinuxX86_64 => macho::CPU_TYPE_X86_64,
    }
}

fn check_native_format(header: &[u8], platform: TabPlatform) -> Result<(), BinaryProblem> {
    let format = ExecutableFormat::detect(header);
    if format == ExecutableFormat::Script {
        return Err(BinaryProblem::Script);
    }
    if !format.is_native_for(platform) {
        return Err(BinaryProblem::NotNative {
            platform,
            found: format,
        });
    }
    Ok(())
}

/// The first [`FORMAT_HEADER_BYTES`] (or fewer) bytes of `file`.
fn read_header(file: &mut (impl Read + Seek)) -> Result<Vec<u8>, BinaryProblem> {
    let unreadable = |error: std::io::Error| BinaryProblem::Unreadable(error.to_string());
    file.seek(std::io::SeekFrom::Start(0)).map_err(unreadable)?;
    let mut header = Vec::with_capacity(FORMAT_HEADER_BYTES);
    file.by_ref()
        .take(FORMAT_HEADER_BYTES as u64)
        .read_to_end(&mut header)
        .map_err(unreadable)?;
    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab::test_support::{elf, mach_o, native_executable, MachOSlice};

    const MACHO_64: &[u8] = b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01";
    const ELF: &[u8] = b"\x7fELF\x02\x01\x01\x00";

    #[test]
    fn recognizes_formats_by_magic_bytes() {
        for macho in [
            MACHO_64,
            b"\xce\xfa\xed\xfe\x07\x00\x00\x00",
            b"\xfe\xed\xfa\xce\x00\x00\x00\x12",
            b"\xfe\xed\xfa\xcf\x01\x00\x00\x07",
            // universal, two architectures (and its 64-bit variant)
            b"\xca\xfe\xba\xbe\x00\x00\x00\x02",
            b"\xca\xfe\xba\xbf\x00\x00\x00\x03",
        ] {
            assert_eq!(ExecutableFormat::detect(macho), ExecutableFormat::MachO);
        }
        assert_eq!(ExecutableFormat::detect(ELF), ExecutableFormat::Elf);
        assert_eq!(
            ExecutableFormat::detect(b"#!/bin/sh\n"),
            ExecutableFormat::Script
        );
        for other in [
            // a Java class file (major version 52 where a fat header counts arches)
            &b"\xca\xfe\xba\xbe\x00\x00\x00\x34"[..],
            b"\xca\xfe\xba\xbe\x00\x00\x00\x00",
            b"\xca\xfe\xba\xbe",
            b"MZ\x90\x00",
            b"\x7fEL",
            b"",
            b"console.log(1)",
        ] {
            assert_eq!(
                ExecutableFormat::detect(other),
                ExecutableFormat::Other,
                "{other:?}"
            );
        }
    }

    #[test]
    fn each_os_runs_only_its_own_format() {
        let macho = ExecutableFormat::MachO;
        assert!(macho.is_native_for(TabPlatform::DarwinAarch64));
        assert!(macho.is_native_for(TabPlatform::DarwinX86_64));
        assert!(!macho.is_native_for(TabPlatform::LinuxX86_64));
        assert!(ExecutableFormat::Elf.is_native_for(TabPlatform::LinuxX86_64));
        assert!(!ExecutableFormat::Elf.is_native_for(TabPlatform::DarwinAarch64));
        for platform in TabPlatform::ALL {
            assert!(!ExecutableFormat::Script.is_native_for(platform));
            assert!(!ExecutableFormat::Other.is_native_for(platform));
        }
    }

    fn signed() -> Vec<u8> {
        native_executable(TabPlatform::DarwinAarch64)
    }

    #[test]
    fn apple_silicon_needs_signed_arm64_code() {
        let (_temp, root) = folder();
        let arm = TabPlatform::DarwinAarch64;
        let cases = [
            (
                mach_o(&[MachOSlice::Arm64Unsigned]),
                Err(BinaryProblem::Unsigned),
            ),
            (
                mach_o(&[MachOSlice::X86_64, MachOSlice::Arm64Unsigned]),
                Err(BinaryProblem::Unsigned),
            ),
            (
                mach_o(&[MachOSlice::X86_64, MachOSlice::Arm64Signed]),
                Ok(()),
            ),
            // Every arm64 image is checked, not only the first.
            (
                mach_o(&[MachOSlice::Arm64Signed, MachOSlice::Arm64Unsigned]),
                Err(BinaryProblem::Unsigned),
            ),
        ];
        for (index, (bytes, expected)) in cases.into_iter().enumerate() {
            let relative = format!("bin/case-{index}");
            write(&root.join(&relative), &bytes, 0o755);
            let result = check_backend_binary(&root, &relative, arm).map(|_| ());
            assert_eq!(result, expected, "case {index}");
        }
        let unsigned = BinaryProblem::Unsigned.to_string();
        assert!(unsigned.contains("codesign -s -"), "{unsigned}");
        // Intel Macs do not require it.
        write(
            &root.join("bin/intel"),
            &mach_o(&[MachOSlice::X86_64, MachOSlice::Arm64Unsigned]),
            0o755,
        );
        assert!(check_backend_binary(&root, "bin/intel", TabPlatform::DarwinX86_64).is_ok());
        write(&root.join("bin/short"), MACHO_64, 0o755);
        let short = check_backend_binary(&root, "bin/short", arm).unwrap_err();
        assert!(matches!(short, BinaryProblem::Malformed(_)), "{short:?}");
        assert!(short.is_wrong_format());
    }

    fn folder() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tab");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let root = root.canonicalize().unwrap();
        (temp, root)
    }

    fn write(path: &Path, bytes: &[u8], mode: u32) {
        std::fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = mode;
    }

    #[test]
    fn in_memory_executables_follow_the_same_format_rules() {
        for platform in TabPlatform::ALL {
            assert_eq!(
                check_backend_bytes(&native_executable(platform), platform),
                Ok(())
            );
        }
        assert_eq!(
            check_backend_bytes(
                &mach_o(&[MachOSlice::Arm64Unsigned]),
                TabPlatform::DarwinAarch64
            ),
            Err(BinaryProblem::Unsigned)
        );
        assert_eq!(
            check_backend_bytes(b"#!/bin/sh\n", TabPlatform::LinuxX86_64),
            Err(BinaryProblem::Script)
        );
        assert_eq!(
            check_backend_bytes(ELF, TabPlatform::DarwinX86_64),
            Err(BinaryProblem::NotNative {
                platform: TabPlatform::DarwinX86_64,
                found: ExecutableFormat::Elf
            })
        );
        assert!(check_backend_bytes(MACHO_64, TabPlatform::DarwinAarch64)
            .unwrap_err()
            .is_wrong_format());
    }

    #[test]
    fn the_code_must_be_for_the_platform_cpu() {
        let wrong_cpu = |bytes: &[u8], platform: TabPlatform| {
            let problem = check_backend_bytes(bytes, platform).unwrap_err();
            assert!(
                matches!(&problem, BinaryProblem::WrongCpu { platform: p, .. } if *p == platform),
                "{problem:?}"
            );
            assert!(problem.is_wrong_format());
            problem.to_string()
        };
        // An arm64-only Mach-O is not an Intel Mac binary, and the reverse:
        // `darwin-aarch64` means native arm64 code, never Rosetta.
        let arm = wrong_cpu(&signed(), TabPlatform::DarwinX86_64);
        assert!(
            arm.contains("built for arm64") && arm.contains("no x86_64 code"),
            "{arm}"
        );
        let intel = wrong_cpu(&mach_o(&[MachOSlice::X86_64]), TabPlatform::DarwinAarch64);
        assert!(intel.contains("built for x86_64"), "{intel}");
        let both = mach_o(&[MachOSlice::X86_64, MachOSlice::X86_64]);
        assert!(wrong_cpu(&both, TabPlatform::DarwinAarch64).contains("x86_64 + x86_64"));
        // A universal file runs where it holds the platform's slice.
        let universal = mach_o(&[MachOSlice::X86_64, MachOSlice::Arm64Signed]);
        for platform in [TabPlatform::DarwinAarch64, TabPlatform::DarwinX86_64] {
            assert_eq!(check_backend_bytes(&universal, platform), Ok(()));
        }
        // ELF: x86_64 only, 64-bit little-endian.
        let aarch64 = wrong_cpu(&elf(183), TabPlatform::LinuxX86_64);
        assert!(aarch64.contains("built for aarch64"), "{aarch64}");
        let mut i386 = elf(3);
        i386[4] = 1;
        assert!(wrong_cpu(&i386, TabPlatform::LinuxX86_64).contains("32-bit x86"));
        let short = check_backend_bytes(ELF, TabPlatform::LinuxX86_64).unwrap_err();
        assert!(matches!(short, BinaryProblem::Malformed(_)), "{short:?}");
        // The same rules on disk.
        let (_temp, root) = folder();
        write(&root.join("bin/arm"), &elf(183), 0o755);
        assert!(matches!(
            check_backend_binary(&root, "bin/arm", TabPlatform::LinuxX86_64),
            Err(BinaryProblem::WrongCpu { .. })
        ));
    }

    #[test]
    fn a_native_executable_inside_the_folder_resolves() {
        let (_temp, root) = folder();
        write(&root.join("bin/mac"), &signed(), 0o755);
        write(
            &root.join("bin/linux"),
            &native_executable(TabPlatform::LinuxX86_64),
            0o755,
        );
        assert_eq!(
            check_backend_binary(&root, "bin/mac", TabPlatform::DarwinAarch64),
            Ok(root.join("bin/mac"))
        );
        assert_eq!(
            check_backend_binary(&root, "bin/linux", TabPlatform::LinuxX86_64),
            Ok(root.join("bin/linux"))
        );
        assert_eq!(
            check_backend_binary(&root, "bin/linux", TabPlatform::DarwinX86_64),
            Err(BinaryProblem::NotNative {
                platform: TabPlatform::DarwinX86_64,
                found: ExecutableFormat::Elf
            })
        );
    }

    #[test]
    fn missing_scripts_and_foreign_files_are_refused() {
        let (_temp, root) = folder();
        let darwin = TabPlatform::DarwinAarch64;
        assert_eq!(
            check_backend_binary(&root, "bin/backend", darwin),
            Err(BinaryProblem::Missing)
        );
        assert_eq!(
            check_backend_binary(&root, "bin", darwin),
            Err(BinaryProblem::NotRegularFile)
        );
        write(&root.join("bin/script"), b"#!/usr/bin/env node\n", 0o755);
        let script = check_backend_binary(&root, "bin/script", darwin).unwrap_err();
        assert_eq!(script, BinaryProblem::Script);
        assert!(script.is_wrong_format());
        assert!(script.to_string().contains("not a script"));
        write(&root.join("bin/text"), b"hello", 0o755);
        let text = check_backend_binary(&root, "bin/text", darwin).unwrap_err();
        assert!(text.is_wrong_format());
        assert!(text.to_string().contains("darwin-aarch64"), "{text}");
        #[cfg(unix)]
        {
            write(&root.join("bin/plain"), &signed(), 0o644);
            assert_eq!(
                check_backend_binary(&root, "bin/plain", darwin),
                Err(BinaryProblem::NotExecutable)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_the_folder() {
        use std::os::unix::fs::symlink;
        let (temp, root) = folder();
        let outside = temp.path().join("outside");
        write(&outside, &signed(), 0o755);
        symlink(&outside, root.join("bin/escape")).unwrap();
        let problem =
            check_backend_binary(&root, "bin/escape", TabPlatform::DarwinAarch64).unwrap_err();
        assert_eq!(problem, BinaryProblem::OutsideFolder);
        assert!(!problem.is_wrong_format());
        // A link that stays inside the folder is the file it names.
        write(&root.join("bin/real"), &signed(), 0o755);
        symlink(root.join("bin/real"), root.join("bin/alias")).unwrap();
        assert_eq!(
            check_backend_binary(&root, "bin/alias", TabPlatform::DarwinAarch64),
            Ok(root.join("bin/real"))
        );
        symlink(temp.path().join("gone"), root.join("bin/dangling")).unwrap();
        assert_eq!(
            check_backend_binary(&root, "bin/dangling", TabPlatform::DarwinAarch64),
            Err(BinaryProblem::Missing)
        );
    }
}
