use std::net::IpAddr;

/// Non-loopback IPv4 addresses of the host, used to build the LAN URLs/QR and
/// to extend the `Host`-header allowlist. IPv6 is intentionally skipped for M1:
/// the QR/URL story is IPv4-only and link-local v6 needs a zone id that doesn't
/// round-trip through a browser URL. Container/VM bridges are skipped too: a
/// phone on the LAN can never reach `docker0` or `virbr0`, and listing them
/// buries the real address in the URL list and the certificate.
pub fn lan_ipv4s() -> Vec<IpAddr> {
    match if_addrs::get_if_addrs() {
        Ok(addrs) => addrs
            .into_iter()
            .filter(|iface| !iface.is_loopback() && !is_virtual_bridge(&iface.name))
            .map(|iface| iface.ip())
            .filter(IpAddr::is_ipv4)
            .collect(),
        Err(err) => {
            tracing::warn!("failed to enumerate network interfaces: {err}");
            Vec::new()
        }
    }
}

/// Linux interface names created by Docker, Podman, libvirt, LXC/LXD and CNI.
/// None of these names exist on macOS, and VPN tunnels (`tailscale0`, `wg0`,
/// `utun*`) are deliberately kept — remote access over Tailscale is supported.
fn is_virtual_bridge(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "docker", "br-", "virbr", "veth", "lxcbr", "lxdbr", "podman", "cni",
    ];
    PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_and_vm_bridges_are_skipped() {
        for name in [
            "docker0",
            "br-3f2a1b",
            "virbr0",
            "veth12ab",
            "lxdbr0",
            "podman1",
            "cni0",
        ] {
            assert!(is_virtual_bridge(name), "{name}");
        }
    }

    #[test]
    fn physical_and_vpn_interfaces_are_kept() {
        for name in [
            "en0",
            "eth0",
            "wlp3s0",
            "enp0s31f6",
            "tailscale0",
            "wg0",
            "utun3",
            "bridge100",
        ] {
            assert!(!is_virtual_bridge(name), "{name}");
        }
    }
}
