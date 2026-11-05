//! Read deployment targets with the same bounded Mach-O header parser as binary validation.
use super::{
    decode, images, read_at, thin_header, CPU_TYPE_ARM64, CPU_TYPE_X86_64, MAX_LOAD_COMMANDS_BYTES,
};
use crate::tab::TabPlatform;
use std::io::{Cursor, Read, Seek};

/// Greatest declared macOS deployment target for the requested architecture.
/// Legacy images without a deployment command return `None`.
pub fn macos_minimum_version(
    bytes: &[u8],
    platform: TabPlatform,
) -> Result<Option<[u32; 3]>, String> {
    let cpu = match platform {
        TabPlatform::DarwinAarch64 => CPU_TYPE_ARM64,
        TabPlatform::DarwinX86_64 => CPU_TYPE_X86_64,
        TabPlatform::LinuxX86_64 => return Ok(None),
    };
    let mut file = Cursor::new(bytes);
    let mut minimum = None;
    for image in images(&mut file)?
        .into_iter()
        .filter(|image| image.cputype == cpu)
    {
        let version = thin_minimum(&mut file, image.offset, cpu)?;
        minimum = minimum.max(version);
    }
    Ok(minimum)
}

fn thin_minimum(
    file: &mut (impl Read + Seek),
    base: u64,
    cpu: u32,
) -> Result<Option<[u32; 3]>, String> {
    let header = thin_header(file, base)?;
    if header.cputype != cpu || header.commands_size > MAX_LOAD_COMMANDS_BYTES {
        return Err("its image architecture or load-command size is invalid".into());
    }
    let mut area = vec![0; header.commands_size as usize];
    let offset = base
        .checked_add(header.size)
        .ok_or("its image offset overflows")?;
    read_at(file, offset, &mut area)?;
    let mut remaining = area.as_slice();
    let mut minimum = None;
    for _ in 0..header.commands {
        if remaining.len() < 8 {
            return Err("its load commands are truncated".into());
        }
        let command = decode(&remaining[..4], header.endian);
        let size = decode(&remaining[4..8], header.endian) as usize;
        if size < 8 || size > remaining.len() {
            return Err("its load command has an invalid size".into());
        }
        let command_bytes = &remaining[..size];
        let version = match command {
            0x24 if size >= 16 => Some(decode(&command_bytes[8..12], header.endian)),
            0x32 if size >= 24 => {
                if decode(&command_bytes[8..12], header.endian) != 1 {
                    return Err("its build-version platform is not macOS".into());
                }
                Some(decode(&command_bytes[12..16], header.endian))
            }
            0x24 | 0x32 => return Err("its deployment-target command is truncated".into()),
            _ => None,
        };
        minimum = minimum.max(version.map(|v| [v >> 16, (v >> 8) & 255, v & 255]));
        remaining = &remaining[size..];
    }
    Ok(minimum)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(command: u32, version: u32, big: bool) -> Vec<u8> {
        let word = |v: u32| {
            if big {
                v.to_be_bytes()
            } else {
                v.to_le_bytes()
            }
        };
        let mut bytes = Vec::new();
        for value in [0xfeed_facf, CPU_TYPE_X86_64, 3, 2, 1, 24, 0, 0, command, 24] {
            bytes.extend(word(value));
        }
        if command == 0x32 {
            bytes.extend(word(1));
        }
        bytes.extend(word(version));
        bytes.resize(56, 0);
        bytes
    }

    #[test]
    fn reads_both_commands_and_byte_orders_and_rejects_malformed_commands() {
        for big in [false, true] {
            for command in [0x24, 0x32] {
                let mut bytes = image(command, 0x000f_0201, big);
                assert_eq!(
                    macos_minimum_version(&bytes, TabPlatform::DarwinX86_64).unwrap(),
                    Some([15, 2, 1])
                );
                assert_eq!(
                    macos_minimum_version(&bytes, TabPlatform::DarwinAarch64).unwrap(),
                    None
                );
                bytes.truncate(52);
                assert!(macos_minimum_version(&bytes, TabPlatform::DarwinX86_64).is_err());
            }
        }
        let mut bytes = image(0x32, 0x000f_0000, false);
        bytes[36..40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(macos_minimum_version(&bytes, TabPlatform::DarwinX86_64).is_err());
        bytes[36..40].copy_from_slice(&24u32.to_le_bytes());
        bytes[40..44].copy_from_slice(&2u32.to_le_bytes());
        assert!(macos_minimum_version(&bytes, TabPlatform::DarwinX86_64).is_err());
    }

    #[test]
    fn universal_images_use_only_the_requested_architecture_and_greatest_floor() {
        let intel = image(0x24, 0x000a_0d00, false);
        let mut arm = image(0x32, 0x000f_0000, false);
        arm[4..8].copy_from_slice(&CPU_TYPE_ARM64.to_le_bytes());
        let newer_intel = image(0x32, 0x000c_0000, false);
        for wide in [false, true] {
            let images = [&intel, &arm, &newer_intel];
            let mut bytes = Vec::new();
            bytes.extend(if wide { 0xcafe_babfu32 } else { 0xcafe_babeu32 }.to_be_bytes());
            bytes.extend(3u32.to_be_bytes());
            let mut offset = 8 + images.len() * if wide { 32 } else { 20 };
            for image in images {
                let cpu = u32::from_le_bytes(image[4..8].try_into().unwrap());
                bytes.extend(cpu.to_be_bytes());
                bytes.extend(0u32.to_be_bytes());
                if wide {
                    bytes.extend((offset as u64).to_be_bytes());
                    bytes.extend((image.len() as u64).to_be_bytes());
                    bytes.extend([0; 8]);
                } else {
                    bytes.extend((offset as u32).to_be_bytes());
                    bytes.extend((image.len() as u32).to_be_bytes());
                    bytes.extend([0; 4]);
                }
                offset += image.len();
            }
            for image in images {
                bytes.extend(image);
            }
            assert_eq!(
                macos_minimum_version(&bytes, TabPlatform::DarwinX86_64).unwrap(),
                Some([12, 0, 0])
            );
            assert_eq!(
                macos_minimum_version(&bytes, TabPlatform::DarwinAarch64).unwrap(),
                Some([15, 0, 0])
            );
        }
    }

    #[test]
    fn missing_legacy_commands_remain_optional_and_reads_are_bounded() {
        let mut bytes = image(0x1b, 0, false);
        assert_eq!(
            macos_minimum_version(&bytes, TabPlatform::DarwinX86_64).unwrap(),
            None
        );
        bytes[20..24].copy_from_slice(&(MAX_LOAD_COMMANDS_BYTES + 1).to_le_bytes());
        assert!(macos_minimum_version(&bytes, TabPlatform::DarwinX86_64).is_err());
        bytes[20..24].copy_from_slice(&24u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&2u32.to_le_bytes());
        assert!(macos_minimum_version(&bytes, TabPlatform::DarwinX86_64).is_err());
    }
}
