//! Linux: the kernel's socket tables, `/proc/net/tcp` and `/proc/net/tcp6`.
//!
//! ```text
//!   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
//!    0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41213 …
//! ```
//!
//! Addresses are the raw 32-bit words of the address in the kernel's byte
//! order, in hex; the port is a plain hex number.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// `st` of a socket in LISTEN state.
const LISTEN: &str = "0A";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    V4,
    V6,
}

/// A listening socket, not yet tied to a process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Socket {
    /// As `lsof` prints it: `*`, `127.0.0.1`, `[::1]`.
    pub address: String,
    pub port: u16,
    pub inode: u64,
}

/// The listening sockets of one table (its header line skipped).
pub fn listening(table: &str, family: Family) -> Vec<Socket> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| parse_line(line, family))
        .collect()
}

fn parse_line(line: &str, family: Family) -> Option<Socket> {
    let columns: Vec<&str> = line.split_whitespace().collect();
    if *columns.get(3)? != LISTEN {
        return None;
    }
    let (address, port) = columns.get(1)?.split_once(':')?;
    // Inode 0: a socket being torn down, which no process holds.
    let inode = columns.get(9)?.parse().ok().filter(|inode| *inode != 0)?;
    Some(Socket {
        address: display(decode(address, family)?),
        port: u16::from_str_radix(port, 16).ok()?,
        inode,
    })
}

fn decode(hex: &str, family: Family) -> Option<IpAddr> {
    let words = match family {
        Family::V4 => 1,
        Family::V6 => 4,
    };
    if hex.len() != words * 8 {
        return None;
    }
    let mut bytes = [0u8; 16];
    for word in 0..words {
        let value = u32::from_str_radix(hex.get(word * 8..word * 8 + 8)?, 16).ok()?;
        bytes[word * 4..word * 4 + 4].copy_from_slice(&value.to_ne_bytes());
    }
    Some(match family {
        Family::V4 => IpAddr::V4(Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3])),
        Family::V6 => IpAddr::V6(Ipv6Addr::from(bytes)),
    })
}

/// `lsof`'s notation, which the page shows as is.
fn display(ip: IpAddr) -> String {
    match ip {
        ip if ip.is_unspecified() => "*".to_owned(),
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    }
}

/// `socket:[41213]`, a `/proc/<pid>/fd/<n>` link target → `41213`.
pub fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

// The tables are in the kernel's byte order; every supported platform is
// little-endian.
#[cfg(all(test, target_endian = "little"))]
mod tests {
    use super::*;

    const TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41213 1 0000000000000000 100 0 0 10 0
   1: 00000000:138D 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1999 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 52000 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 100 0 0 10 0
";

    const TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7001 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7002 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7003 1 0000000000000000 100 0 0 10 0
";

    fn socket(address: &str, port: u16, inode: u64) -> Socket {
        Socket {
            address: address.into(),
            port,
            inode,
        }
    }

    #[test]
    fn keeps_listening_ipv4_sockets_only() {
        assert_eq!(
            listening(TCP, Family::V4),
            [socket("127.0.0.1", 8080, 41213), socket("*", 5005, 1999)]
        );
    }

    #[test]
    fn decodes_ipv6_words() {
        assert_eq!(
            listening(TCP6, Family::V6),
            [
                socket("[::1]", 3000, 7001),
                socket("*", 8000, 7002),
                socket("[::ffff:127.0.0.1]", 80, 7003),
            ]
        );
    }

    #[test]
    fn skips_lines_of_the_wrong_family_or_shape() {
        assert!(listening(TCP6, Family::V4).is_empty());
        assert!(listening(TCP, Family::V6).is_empty());
        assert!(listening("header\n0: garbage\n\n", Family::V4).is_empty());
    }

    #[test]
    fn reads_socket_links() {
        assert_eq!(socket_inode("socket:[41213]"), Some(41213));
        assert_eq!(socket_inode("pipe:[41213]"), None);
        assert_eq!(socket_inode("/dev/null"), None);
    }
}
