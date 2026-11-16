//! Address classification for outbound fetches made on someone else's behalf.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Whether `address` is globally routable: not loopback, private, link-local,
/// shared, documentation, multicast, mapped or otherwise reserved.
pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => is_public_v6(address),
    }
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    ![
        ("0.0.0.0", 8),
        ("10.0.0.0", 8),
        ("100.64.0.0", 10),
        ("127.0.0.0", 8),
        ("169.254.0.0", 16),
        ("172.16.0.0", 12),
        ("192.0.0.0", 24),
        ("192.0.2.0", 24),
        ("192.88.99.0", 24),
        ("192.168.0.0", 16),
        ("198.18.0.0", 15),
        ("198.51.100.0", 24),
        ("203.0.113.0", 24),
        ("224.0.0.0", 4),
        ("240.0.0.0", 4),
    ]
    .into_iter()
    .any(|(network, prefix)| {
        ipv4_in_prefix(
            address,
            network.parse().expect("static IPv4 network"),
            prefix,
        )
    })
}

fn ipv4_in_prefix(address: Ipv4Addr, network: Ipv4Addr, prefix: u32) -> bool {
    let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
    u32::from(address) & mask == u32::from(network) & mask
}

fn is_public_v6(address: Ipv6Addr) -> bool {
    // Public IPv6 unicast is allocated from 2000::/3. Exclude the special-use
    // sub-ranges inside it as well; everything outside it is local, mapped,
    // multicast, documentation, or reserved.
    ipv6_in_prefix(address, "2000::".parse().unwrap(), 3)
        && ![
            ("2001::", 23),
            ("2001:db8::", 32),
            ("2002::", 16),
            ("3fff::", 20),
        ]
        .into_iter()
        .any(|(network, prefix)| {
            ipv6_in_prefix(
                address,
                network.parse().expect("static IPv6 network"),
                prefix,
            )
        })
}

fn ipv6_in_prefix(address: Ipv6Addr, network: Ipv6Addr, prefix: u32) -> bool {
    let mask = u128::MAX.checked_shl(128 - prefix).unwrap_or(0);
    u128::from(address) & mask == u128::from(network) & mask
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_globally_routable_addresses_are_public() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "0.0.0.1",
            "198.18.0.1",
            "240.0.0.1",
            "::1",
            "fc00::1",
            "fec0::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:192.168.1.1",
        ] {
            let address: IpAddr = address.parse().expect("test IP");
            assert!(!is_public_ip(address), "{address}");
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}
