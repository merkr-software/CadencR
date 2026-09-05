//! Resource-limit controls and honest platform capability reporting.

use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[cfg(not(windows))]
use super::ManagedProcessPolicyErrorCode;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::MANAGED_CPU_TIME_SECONDS;
#[cfg(target_os = "linux")]
use super::MANAGED_MEMORY_BYTES;
use super::{ManagedProcessPolicyError, MANAGED_PROCESS_TIMEOUT};

/// Whether an operating-system process control is enforceable on this host.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ManagedProcessControlOutcome {
    Applied,
    Unavailable { reason: String },
}

/// Explicit process controls applied to managed provider commands.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct ManagedProcessPolicyOutcome {
    pub default_one_shot_timeout_seconds: u64,
    pub descendant_termination: ManagedProcessControlOutcome,
    pub cpu_limit: ManagedProcessControlOutcome,
    pub memory_limit: ManagedProcessControlOutcome,
    pub child_count_limit: ManagedProcessControlOutcome,
}

/// Report controls honestly without implying filesystem or network isolation.
pub fn managed_process_policy_outcome() -> ManagedProcessPolicyOutcome {
    #[cfg(windows)]
    return fully_applied();
    #[cfg(target_os = "linux")]
    return ManagedProcessPolicyOutcome {
        default_one_shot_timeout_seconds: MANAGED_PROCESS_TIMEOUT.as_secs(),
        descendant_termination: ManagedProcessControlOutcome::Applied,
        cpu_limit: ManagedProcessControlOutcome::Applied,
        memory_limit: ManagedProcessControlOutcome::Applied,
        child_count_limit: unavailable_unix_process_limit(),
    };
    #[cfg(target_os = "macos")]
    return ManagedProcessPolicyOutcome {
        default_one_shot_timeout_seconds: MANAGED_PROCESS_TIMEOUT.as_secs(),
        descendant_termination: ManagedProcessControlOutcome::Applied,
        cpu_limit: ManagedProcessControlOutcome::Applied,
        memory_limit: ManagedProcessControlOutcome::Unavailable {
            reason: "macOS rejects RLIMIT_AS changes for child processes".into(),
        },
        child_count_limit: unavailable_unix_process_limit(),
    };
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    ManagedProcessPolicyOutcome {
        default_one_shot_timeout_seconds: MANAGED_PROCESS_TIMEOUT.as_secs(),
        descendant_termination: unavailable_platform_control(),
        cpu_limit: unavailable_platform_control(),
        memory_limit: unavailable_platform_control(),
        child_count_limit: unavailable_platform_control(),
    }
}

#[cfg(windows)]
fn fully_applied() -> ManagedProcessPolicyOutcome {
    ManagedProcessPolicyOutcome {
        default_one_shot_timeout_seconds: MANAGED_PROCESS_TIMEOUT.as_secs(),
        descendant_termination: ManagedProcessControlOutcome::Applied,
        cpu_limit: ManagedProcessControlOutcome::Applied,
        memory_limit: ManagedProcessControlOutcome::Applied,
        child_count_limit: ManagedProcessControlOutcome::Applied,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unavailable_unix_process_limit() -> ManagedProcessControlOutcome {
    ManagedProcessControlOutcome::Unavailable {
        reason: "RLIMIT_NPROC is per-user, so applying it to one provider is unsafe".into(),
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn unavailable_platform_control() -> ManagedProcessControlOutcome {
    ManagedProcessControlOutcome::Unavailable {
        reason: "managed process controls are unavailable on this platform".into(),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn configure_resource_limits(
    command: &mut Command,
) -> Result<(), ManagedProcessPolicyError> {
    use std::os::unix::process::CommandExt;

    let cpu = bounded_rlimit(libc::RLIMIT_CPU, MANAGED_CPU_TIME_SECONDS)?;
    #[cfg(target_os = "linux")]
    let memory = bounded_rlimit(libc::RLIMIT_AS, MANAGED_MEMORY_BYTES)?;
    unsafe {
        command.as_std_mut().pre_exec(move || {
            if libc::setrlimit(libc::RLIMIT_CPU, &raw_rlimit(cpu)) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            if libc::setrlimit(libc::RLIMIT_AS, &raw_rlimit(memory)) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn configure_resource_limits(
    _command: &mut Command,
) -> Result<(), ManagedProcessPolicyError> {
    // The Job Object is attached around spawn by the ACP and one-shot reapers.
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(super) fn configure_resource_limits(
    _command: &mut Command,
) -> Result<(), ManagedProcessPolicyError> {
    Err(ManagedProcessPolicyError::new(
        ManagedProcessPolicyErrorCode::ResourceLimitUnavailable,
        "managed resource limits are unavailable on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn bounded_rlimit(
    resource: RLimitResource,
    desired: u64,
) -> Result<(libc::rlim_t, libc::rlim_t), ManagedProcessPolicyError> {
    let mut current = raw_rlimit((0, 0));
    if unsafe { libc::getrlimit(resource, &mut current) } != 0 {
        return Err(ManagedProcessPolicyError::new(
            ManagedProcessPolicyErrorCode::ResourceLimitUnavailable,
            format!(
                "could not inspect managed resource limit: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    let desired = libc::rlim_t::try_from(desired).unwrap_or(libc::RLIM_INFINITY);
    let soft = if current.rlim_cur == libc::RLIM_INFINITY {
        desired
    } else {
        current.rlim_cur.min(desired)
    };
    Ok((soft, current.rlim_max))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn raw_rlimit((soft, hard): (libc::rlim_t, libc::rlim_t)) -> libc::rlimit {
    libc::rlimit {
        rlim_cur: soft,
        rlim_max: hard,
    }
}

#[cfg(target_os = "macos")]
type RLimitResource = libc::c_int;
#[cfg(target_os = "linux")]
type RLimitResource = libc::__rlimit_resource_t;
