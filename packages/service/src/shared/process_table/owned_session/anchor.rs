//! Durable proof of one Unix session. A live, exact anchor reserves the
//! original SID after the launcher exits, including across a service crash.

use std::io;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{confirm_no_peers, drain_session, matches_session, platform, verified_tree};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BootIdentity {
    boot: [u8; 16],
    pid_namespace: Option<u64>,
}

impl BootIdentity {
    pub(crate) async fn current() -> io::Result<Self> {
        tokio::task::spawn_blocking(read_boot_identity)
            .await
            .map_err(io::Error::other)?
    }

    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self {
            boot: Uuid::new_v4().into_bytes(),
            pid_namespace: None,
        }
    }

    /// Another boot conclusively ended our processes. Another namespace on
    /// this boot may still have them, but cannot verify or stop them here.
    fn same_namespace(&self, current: &Self) -> io::Result<bool> {
        if self.boot != current.boot {
            return Ok(false);
        }
        if self.pid_namespace != current.pid_namespace {
            return Err(io::Error::other(
                "the recorded process session is in another PID namespace",
            ));
        }
        Ok(true)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct SessionAnchor {
    boot: BootIdentity,
    leader: u32,
    anchor: i32,
    generation: String,
}

impl SessionAnchor {
    pub(crate) async fn capture(boot: BootIdentity, leader: u32, anchor: u32) -> io::Result<Self> {
        tokio::task::spawn_blocking(move || {
            let sid = i32::try_from(leader).map_err(io::Error::other)?;
            let anchor = i32::try_from(anchor).map_err(io::Error::other)?;
            if sid <= 1 || anchor <= 1 || sid == anchor || !matches_session(sid, sid)? {
                return Err(io::Error::other("invalid private process session"));
            }
            let generation = platform::anchor_generation(anchor)?
                .ok_or_else(|| io::Error::other("the process session anchor is missing"))?;
            let recorded = Self {
                boot,
                leader,
                anchor,
                generation,
            };
            if recorded.target()?.is_none() {
                return Err(io::Error::other(
                    "could not verify the process session anchor",
                ));
            }
            Ok(recorded)
        })
        .await
        .map_err(io::Error::other)?
    }

    pub(crate) fn anchor_pid(&self) -> i32 {
        self.anchor
    }

    pub(crate) fn leader(&self) -> u32 {
        self.leader
    }

    /// Returns whether a live anchor was found. A vanished anchor can only
    /// settle an active record if the original SID has no visible survivors.
    pub(crate) async fn stop_peers(&self, current: &BootIdentity) -> io::Result<bool> {
        if !self.boot.same_namespace(current)? {
            return Ok(false);
        }
        if let Some(anchor) = self.target()? {
            drain_session(self.leader as i32, Some(self.anchor), Some(&anchor)).await?;
            return Ok(true);
        }
        confirm_no_peers(self.leader as i32).await?;
        Ok(false)
    }

    /// Call only after persisting that all other members have stopped. If the
    /// anchor is now gone, no remaining process can be the old session's.
    pub(crate) async fn stop_anchor(&self, current: &BootIdentity) -> io::Result<()> {
        if !self.boot.same_namespace(current)? {
            return Ok(());
        }
        let Some(anchor) = self.target()? else {
            return Ok(());
        };
        anchor.signal(libc::SIGKILL)?;
        if !verified_tree::wait_for_exit(std::slice::from_ref(&anchor)).await? {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the process session anchor did not stop",
            ));
        }
        Ok(())
    }

    fn target(&self) -> io::Result<Option<platform::Target>> {
        let leader = i32::try_from(self.leader).map_err(io::Error::other)?;
        if leader <= 1 || self.anchor <= 1 || self.anchor == leader || self.generation.is_empty() {
            return Err(io::Error::other("invalid recorded process session"));
        }
        platform::Target::capture_if(self.anchor, || {
            Ok(platform::anchor_generation(self.anchor)?.as_deref()
                == Some(self.generation.as_str())
                && matches_session(self.anchor, leader)?)
        })
    }
}

#[cfg(target_os = "linux")]
fn read_boot_identity() -> io::Result<BootIdentity> {
    use std::os::unix::fs::MetadataExt;

    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    Ok(BootIdentity {
        boot: boot_uuid(boot.trim())?,
        pid_namespace: Some(std::fs::metadata("/proc/self/ns/pid")?.ino()),
    })
}

#[cfg(target_os = "macos")]
fn read_boot_identity() -> io::Result<BootIdentity> {
    let mut output = [0_u8; 64];
    let mut length = output.len();
    // SAFETY: sysctlbyname writes no more than length bytes into output.
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            output.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let end = output
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(output.len());
    let boot = std::str::from_utf8(&output[..end]).map_err(io::Error::other)?;
    Ok(BootIdentity {
        boot: boot_uuid(boot)?,
        pid_namespace: None,
    })
}

fn boot_uuid(value: &str) -> io::Result<[u8; 16]> {
    Uuid::parse_str(value)
        .map(Uuid::into_bytes)
        .map_err(io::Error::other)
}
