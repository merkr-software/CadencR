//! The CPU an ELF file is built for, read from its identification bytes and
//! `e_machine` — the first 20 bytes of the header.

use std::io::{Read, Seek, SeekFrom};

const EM_X86_64: u16 = 62;
const HEADER_BYTES: usize = 20;

/// `Ok(None)` for 64-bit little-endian x86_64 code (what `linux-x86_64`
/// runs); `Ok(Some(what))` names what the file is built for instead. `Err`
/// names what is malformed about it.
pub(crate) fn foreign_to_x86_64(file: &mut (impl Read + Seek)) -> Result<Option<String>, String> {
    let mut header = [0u8; HEADER_BYTES];
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.read_exact(&mut header))
        .map_err(|_| "its ELF header is truncated".to_string())?;
    let little = match header[5] {
        1 => true,
        2 => false,
        other => return Err(format!("its ELF byte order ({other}) is invalid")),
    };
    let machine_bytes = [header[18], header[19]];
    let machine = if little {
        u16::from_le_bytes(machine_bytes)
    } else {
        u16::from_be_bytes(machine_bytes)
    };
    match (header[4], little, machine) {
        (2, true, EM_X86_64) => Ok(None),
        (2, true, _) => Ok(Some(machine_name(machine))),
        (2, false, _) => Ok(Some(format!("big-endian {}", machine_name(machine)))),
        (1, _, _) => Ok(Some(format!("32-bit {}", machine_name(machine)))),
        (other, _, _) => Err(format!("its ELF class ({other}) is invalid")),
    }
}

fn machine_name(machine: u16) -> String {
    match machine {
        3 => "x86".into(),
        8 => "MIPS".into(),
        20 => "PowerPC".into(),
        21 => "PowerPC64".into(),
        22 => "s390".into(),
        40 => "32-bit ARM".into(),
        EM_X86_64 => "x86_64".into(),
        183 => "aarch64".into(),
        243 => "RISC-V".into(),
        other => format!("ELF machine {other}"),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::tab::test_support::elf;

    fn check(bytes: Vec<u8>) -> Result<Option<String>, String> {
        foreign_to_x86_64(&mut Cursor::new(bytes))
    }

    #[test]
    fn only_64_bit_little_endian_x86_64_is_native() {
        assert_eq!(check(elf(62)), Ok(None));
        assert_eq!(check(elf(183)), Ok(Some("aarch64".into())));
        assert_eq!(check(elf(7)), Ok(Some("ELF machine 7".into())));
        let mut thirty_two = elf(3);
        thirty_two[4] = 1;
        assert_eq!(check(thirty_two), Ok(Some("32-bit x86".into())));
        let mut big = elf(62);
        big[5] = 2;
        big[18..20].copy_from_slice(&62u16.to_be_bytes());
        assert_eq!(check(big), Ok(Some("big-endian x86_64".into())));
    }

    #[test]
    fn a_short_or_invalid_header_is_malformed() {
        assert!(check(b"\x7fELF\x02\x01\x01\x00".to_vec()).is_err());
        let mut class = elf(62);
        class[4] = 9;
        assert!(check(class).is_err());
        let mut order = elf(62);
        order[5] = 0;
        assert!(check(order).is_err());
    }
}
