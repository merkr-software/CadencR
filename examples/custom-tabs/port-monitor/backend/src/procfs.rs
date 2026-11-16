//! Linux: everything from `/proc`, no external program. The socket tables
//! list every listening socket; the process holding one is found by its
//! inode among `/proc/<pid>/fd/*`. Another user's descriptors cannot be read
//! without root, so — like `lsof` — only the user's own processes show up,
//! which is what the tab can act on anyway.

use std::collections::{HashMap, HashSet};
use std::ffi::CStr;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use cadencr_tab_backend::Error;

use crate::ports::{Listening, ProcessInfo, Snapshot};
use crate::proc_net::{self, Family};

const TABLES: [(&str, Family); 2] = [
    ("/proc/net/tcp", Family::V4),
    ("/proc/net/tcp6", Family::V6),
];

fn unavailable(path: &str, error: std::io::Error) -> Error {
    Error::new("PROC_UNAVAILABLE", format!("Cannot read {path}: {error}"))
}

pub fn snapshot() -> Result<Snapshot, Error> {
    let mut sockets = Vec::new();
    for (path, family) in TABLES {
        match fs::read_to_string(path) {
            Ok(table) => sockets.extend(proc_net::listening(&table, family)),
            // A kernel built without IPv6 has no tcp6 table.
            Err(error) if error.kind() == ErrorKind::NotFound && family == Family::V6 => {}
            Err(error) => return Err(unavailable(path, error)),
        }
    }
    let inodes: HashSet<u64> = sockets.iter().map(|socket| socket.inode).collect();
    let owners = socket_owners(&inodes)?;
    let mut snapshot = Snapshot::default();
    let mut users = HashMap::new();
    for socket in sockets {
        for &pid in owners.get(&socket.inode).into_iter().flatten() {
            snapshot
                .processes
                .entry(pid)
                .or_insert_with(|| process_info(pid, &mut users));
            snapshot.listening.push(Listening {
                pid,
                address: socket.address.clone(),
                port: socket.port,
            });
        }
    }
    Ok(snapshot)
}

/// The processes holding each socket in `inodes`.
fn socket_owners(inodes: &HashSet<u64>) -> Result<HashMap<u64, Vec<u32>>, Error> {
    let mut owners: HashMap<u64, Vec<u32>> = HashMap::new();
    if inodes.is_empty() {
        return Ok(owners);
    }
    let processes = fs::read_dir("/proc").map_err(|error| unavailable("/proc", error))?;
    for entry in processes.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        // Unreadable: another user's process, or one that just exited.
        let Ok(descriptors) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for descriptor in descriptors.flatten() {
            let Ok(link) = fs::read_link(descriptor.path()) else {
                continue;
            };
            let inode = link.to_str().and_then(proc_net::socket_inode);
            if let Some(inode) = inode.filter(|inode| inodes.contains(inode)) {
                let pids = owners.entry(inode).or_default();
                if !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
    }
    Ok(owners)
}

/// What `/proc/<pid>` tells; empty fields for a process gone since the scan.
fn process_info(pid: u32, users: &mut HashMap<u32, String>) -> ProcessInfo {
    let dir = Path::new("/proc").join(pid.to_string());
    let command = fs::read_to_string(dir.join("comm"))
        .map(|comm| comm.trim_end_matches('\n').to_owned())
        .unwrap_or_default();
    // Like `lsof`: the login name, else the numeric uid.
    let user = fs::metadata(&dir).ok().map(|metadata| {
        let uid = metadata.uid();
        users
            .entry(uid)
            .or_insert_with(|| user_name(uid).unwrap_or_else(|| uid.to_string()))
            .clone()
    });
    ProcessInfo {
        command,
        user,
        cwd: fs::read_link(dir.join("cwd")).ok(),
    }
}

/// The login name of `uid`, through the system's user database (NSS).
fn user_name(uid: u32) -> Option<String> {
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: an all-zero `passwd` is a valid value (null pointers, zero ids).
    let mut passwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the call, and `buffer.len()` is the
    // buffer's real size; `getpwuid_r` writes only into `passwd` and `buffer`.
    let status = unsafe {
        libc::getpwuid_r(
            uid,
            &mut passwd,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || passwd.pw_name.is_null() {
        return None;
    }
    // SAFETY: on success `pw_name` points to a NUL-terminated string inside
    // `buffer`, which outlives this borrow.
    let name = unsafe { CStr::from_ptr(passwd.pw_name) };
    Some(name.to_string_lossy().into_owned())
}
