//! What a Mach-O file holds: the CPU of each image, and whether its arm64
//! code carries a code signature.
//!
//! A universal (fat) file lists one image per architecture; a thin file is
//! one image. The platform check needs an image for the platform's CPU.
//!
//! On Apple silicon the kernel kills an arm64 executable without a signature
//! at launch, before it writes a byte — so a backend that would only ever die
//! with `SIGKILL` is refused up front with a fix instead. The Rust (and Xcode)
//! linker ad-hoc signs arm64 output by default; `strip` or a hand-edited file
//! can lose it. Only the `LC_CODE_SIGNATURE` load command's presence is
//! checked, not the signature: validity is the kernel's job. Every arm64
//! image is checked (a universal file may carry several, e.g. arm64 and
//! arm64e): the loader may pick any of them.

mod minimum;
pub use minimum::macos_minimum_version;

use std::io::{Read, Seek, SeekFrom};

pub(crate) const CPU_TYPE_X86_64: u32 = 0x0100_0007;
pub(crate) const CPU_TYPE_ARM64: u32 = 0x0100_000c;
/// Thin-image magics as big-endian words: 32- and 64-bit, both byte orders.
pub(crate) const THIN_MAGICS: [u32; 4] = [0xfeed_face, 0xcefa_edfe, 0xfeed_facf, 0xcffa_edfe];
/// Universal-file magics (`fat_header`, `fat_header_64`), always big-endian.
pub(crate) const FAT_MAGICS: [u32; 2] = [0xcafe_babe, 0xcafe_babf];
/// A universal header lists at most this many architectures; past it the
/// `cafebabe` magic is a Java class file.
pub(crate) const MAX_FAT_ARCHES: u32 = 30;
const LC_CODE_SIGNATURE: u32 = 0x1d;
/// Largest load-command area read; real executables use a few KiB.
const MAX_LOAD_COMMANDS_BYTES: u32 = 1024 * 1024;
/// The `mach_header` fields read: magic through `sizeofcmds` and `flags`.
const THIN_HEADER_PREFIX: usize = 28;

/// One image of a Mach-O file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Image {
    pub cputype: u32,
    /// Where its thin header starts.
    offset: u64,
}

/// What the arm64 code of a Mach-O file says about its signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Arm64Signature {
    /// No arm64 image at all.
    NoArm64Code,
    /// Every arm64 image is signed.
    Signed,
    /// At least one arm64 image is not.
    Unsigned,
}

/// The images of `file`, already recognized as Mach-O by its magic: one for
/// a thin file, one per listed architecture for a universal file. `Err`
/// names what is malformed about it.
pub(crate) fn images(file: &mut (impl Read + Seek)) -> Result<Vec<Image>, String> {
    let mut start = [0; 8];
    read_at(file, 0, &mut start)?;
    let magic = decode(&start[0..4], Endian::Big);
    if !FAT_MAGICS.contains(&magic) {
        let header = thin_header(file, 0)?;
        return Ok(vec![Image {
            cputype: header.cputype,
            offset: 0,
        }]);
    }
    let wide = magic == FAT_MAGICS[1];
    let arches = decode(&start[4..8], Endian::Big);
    if arches > MAX_FAT_ARCHES {
        return Err(format!("its universal header lists {arches} architectures"));
    }
    let entry_size = if wide { 32 } else { 20 };
    let mut table = vec![0; arches as usize * entry_size];
    read_at(file, 8, &mut table)?;
    Ok(table
        .chunks_exact(entry_size)
        .map(|entry| Image {
            cputype: decode(&entry[0..4], Endian::Big),
            offset: if wide {
                u64::from_be_bytes(entry[8..16].try_into().expect("8 bytes"))
            } else {
                u64::from(decode(&entry[8..12], Endian::Big))
            },
        })
        .collect())
}

/// The signature state of `file`'s arm64 code, judged on every arm64 image
/// of `images` (what [`images`] returned for `file`).
pub(crate) fn arm64_signature(
    file: &mut (impl Read + Seek),
    images: &[Image],
) -> Result<Arm64Signature, String> {
    let mut state = Arm64Signature::NoArm64Code;
    for image in images {
        if image.cputype != CPU_TYPE_ARM64 {
            continue;
        }
        if !thin_signed(file, image.offset)? {
            return Ok(Arm64Signature::Unsigned);
        }
        state = Arm64Signature::Signed;
    }
    Ok(state)
}

/// A human name for a Mach-O CPU type.
pub(crate) fn cpu_name(cputype: u32) -> String {
    match cputype {
        CPU_TYPE_X86_64 => "x86_64".into(),
        CPU_TYPE_ARM64 => "arm64".into(),
        0x0200_000c => "arm64_32".into(),
        7 => "i386".into(),
        12 => "32-bit ARM".into(),
        18 => "PowerPC".into(),
        other => format!("CPU type {other:#x}"),
    }
}

#[derive(Clone, Copy)]
enum Endian {
    Big,
    Little,
}

/// The `mach_header` fields of the thin image starting at `base`.
struct ThinHeader {
    endian: Endian,
    /// 28 bytes for a 32-bit header, 32 for a 64-bit one.
    size: u64,
    cputype: u32,
    commands: u32,
    commands_size: u32,
}

fn thin_header(file: &mut (impl Read + Seek), base: u64) -> Result<ThinHeader, String> {
    let mut bytes = [0; THIN_HEADER_PREFIX];
    read_at(file, base, &mut bytes)?;
    let (endian, size) = match decode(&bytes[0..4], Endian::Big) {
        0xfeed_face => (Endian::Big, 28),
        0xfeed_facf => (Endian::Big, 32),
        0xcefa_edfe => (Endian::Little, 28),
        0xcffa_edfe => (Endian::Little, 32),
        _ => return Err("an image it lists is not a Mach-O image".into()),
    };
    Ok(ThinHeader {
        endian,
        size,
        cputype: decode(&bytes[4..8], endian),
        commands: decode(&bytes[16..20], endian),
        commands_size: decode(&bytes[20..24], endian),
    })
}

/// Whether the arm64 image at `base` carries an `LC_CODE_SIGNATURE`.
fn thin_signed(file: &mut (impl Read + Seek), base: u64) -> Result<bool, String> {
    let header = thin_header(file, base)?;
    if header.cputype != CPU_TYPE_ARM64 {
        return Err("its universal header lists an arm64 image that is not arm64 code".into());
    }
    if header.commands_size > MAX_LOAD_COMMANDS_BYTES {
        return Err(format!(
            "it declares {} bytes of load commands",
            header.commands_size
        ));
    }
    let mut area = vec![0; header.commands_size as usize];
    read_at(file, base + header.size, &mut area)?;
    let mut at = 0usize;
    for _ in 0..header.commands {
        let field = |offset: usize| -> Result<u32, String> {
            area.get(offset..offset + 4)
                .map(|bytes| decode(bytes, header.endian))
                .ok_or_else(|| "its load commands are truncated".to_string())
        };
        let (command, size) = (field(at)?, field(at + 4)? as usize);
        if command == LC_CODE_SIGNATURE {
            return Ok(true);
        }
        if size < 8 {
            return Err("a load command is shorter than its header".into());
        }
        at += size;
    }
    Ok(false)
}

fn decode(bytes: &[u8], endian: Endian) -> u32 {
    let bytes = [bytes[0], bytes[1], bytes[2], bytes[3]];
    match endian {
        Endian::Big => u32::from_be_bytes(bytes),
        Endian::Little => u32::from_le_bytes(bytes),
    }
}

fn read_at(file: &mut (impl Read + Seek), offset: u64, buffer: &mut [u8]) -> Result<(), String> {
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(buffer))
        .map_err(|_| "it is truncated".to_string())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::tab::test_support::{mach_o, MachOSlice};

    fn check(bytes: Vec<u8>) -> Result<Arm64Signature, String> {
        let mut file = Cursor::new(bytes);
        let images = images(&mut file)?;
        arm64_signature(&mut file, &images)
    }

    #[test]
    fn thin_arm64_needs_a_signature_load_command() {
        assert_eq!(
            check(mach_o(&[MachOSlice::Arm64Signed])),
            Ok(Arm64Signature::Signed)
        );
        assert_eq!(
            check(mach_o(&[MachOSlice::Arm64Unsigned])),
            Ok(Arm64Signature::Unsigned)
        );
        assert_eq!(
            check(mach_o(&[MachOSlice::X86_64])),
            Ok(Arm64Signature::NoArm64Code)
        );
    }

    #[test]
    fn universal_files_are_judged_by_their_arm64_slice() {
        let signed = mach_o(&[MachOSlice::X86_64, MachOSlice::Arm64Signed]);
        assert_eq!(check(signed), Ok(Arm64Signature::Signed));
        let unsigned = mach_o(&[MachOSlice::X86_64, MachOSlice::Arm64Unsigned]);
        assert_eq!(check(unsigned), Ok(Arm64Signature::Unsigned));
        let intel = mach_o(&[MachOSlice::X86_64, MachOSlice::X86_64]);
        assert_eq!(check(intel), Ok(Arm64Signature::NoArm64Code));
    }

    #[test]
    fn every_arm64_image_must_be_signed() {
        let second_unsigned = mach_o(&[MachOSlice::Arm64Signed, MachOSlice::Arm64Unsigned]);
        assert_eq!(check(second_unsigned), Ok(Arm64Signature::Unsigned));
        let first_unsigned = mach_o(&[MachOSlice::Arm64Unsigned, MachOSlice::Arm64Signed]);
        assert_eq!(check(first_unsigned), Ok(Arm64Signature::Unsigned));
        let both = mach_o(&[MachOSlice::Arm64Signed, MachOSlice::Arm64Signed]);
        assert_eq!(check(both), Ok(Arm64Signature::Signed));
    }

    #[test]
    fn lists_the_cpu_of_every_image() {
        let cpus = |bytes: Vec<u8>| -> Vec<u32> {
            images(&mut Cursor::new(bytes))
                .unwrap()
                .iter()
                .map(|image| image.cputype)
                .collect()
        };
        assert_eq!(cpus(mach_o(&[MachOSlice::X86_64])), [CPU_TYPE_X86_64]);
        assert_eq!(
            cpus(mach_o(&[MachOSlice::X86_64, MachOSlice::Arm64Signed])),
            [CPU_TYPE_X86_64, CPU_TYPE_ARM64]
        );
        assert_eq!(cpu_name(CPU_TYPE_ARM64), "arm64");
        assert_eq!(cpu_name(0x42), "CPU type 0x42");
    }

    #[test]
    fn truncated_files_are_malformed() {
        let mut bytes = mach_o(&[MachOSlice::Arm64Signed]);
        bytes.truncate(36);
        assert!(check(bytes).is_err());
        assert!(check(b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01".to_vec()).is_err());
        let mut fat = mach_o(&[MachOSlice::X86_64, MachOSlice::Arm64Signed]);
        fat.truncate(12);
        assert!(check(fat).is_err());
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn this_test_binary_is_signed_by_the_linker() {
        let mut file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
        let images = images(&mut file).unwrap();
        assert_eq!(
            arm64_signature(&mut file, &images),
            Ok(Arm64Signature::Signed)
        );
    }
}
