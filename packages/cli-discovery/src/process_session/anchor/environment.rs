//! Pass the target environment as bytes after authorization. In particular,
//! a provider's dynamic-loader settings may not reach the launcher itself.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;

const MAX_ENV_BYTES: usize = 16 * 1024 * 1024;

pub(super) fn take_from(command: &mut tokio::process::Command) -> io::Result<Vec<u8>> {
    let mut frame = vec![0; 4];
    for (key, value) in command.as_std().get_envs() {
        let Some(value) = value else { continue };
        let (key, value) = (key.as_bytes(), value.as_bytes());
        if key.is_empty() || key.contains(&b'=') || key.contains(&0) || value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid provider environment",
            ));
        }
        frame.extend_from_slice(key);
        frame.push(b'=');
        frame.extend_from_slice(value);
        frame.push(0);
    }
    let length = frame.len() - 4;
    if length > MAX_ENV_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "provider environment is too large",
        ));
    }
    frame[..4].copy_from_slice(&(length as u32).to_ne_bytes());
    command.env_clear();
    Ok(frame)
}

pub(super) fn read_into(command: &mut std::process::Command) -> io::Result<()> {
    // The host waits for the launch acknowledgement before sending any
    // provider protocol bytes, so this buffer contains only the frame.
    let mut input = io::stdin().lock();
    let mut length = [0; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_ne_bytes(length) as usize;
    if length > MAX_ENV_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "provider environment is too large",
        ));
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    command.env_clear();
    for entry in bytes
        .split(|&byte| byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let equals = entry.iter().position(|&byte| byte == b'=').ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid provider environment")
        })?;
        command.env(
            OsStr::from_bytes(&entry[..equals]),
            OsStr::from_bytes(&entry[equals + 1..]),
        );
    }
    Ok(())
}
