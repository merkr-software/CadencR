#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::future::Future;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cli_discovery::{session_command, AnchorRecord, ChildSession, ChildSessionObserver};
use tokio::io::AsyncReadExt;
use tokio::net::unix::pipe::Receiver;
use tokio::sync::Mutex;

struct Refuse;

impl ChildSessionObserver for Refuse {
    fn started(&self, _: u32) {
        panic!("the owned launcher must await authorization");
    }

    fn before_reap(&self, _: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        unreachable!()
    }

    fn record_anchor(&self, leader: u32, anchor: u32) -> AnchorRecord<'_> {
        assert!(anchor > 1 && leader > 1 && anchor != leader);
        Box::pin(async { Err(io::Error::other("fixture refused ownership record")) })
    }
}

#[tokio::test]
async fn the_service_launcher_never_execs_the_provider_when_ownership_recording_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("provider-executed");
    let session = ChildSession::with_anchor(
        Arc::new(Refuse),
        env!("CARGO_BIN_EXE_cadencr-service").into(),
    );
    let mut command = session_command("/bin/sh", Some(&session));
    command
        .args(["-c", "touch \"$1\"", "provider"])
        .arg(&output)
        .stderr(Stdio::null());
    let error = session.spawn(command).await.unwrap_err();
    assert!(error
        .to_string()
        .contains("fixture refused ownership record"));
    assert!(!output.exists());
}

struct UnrelatedDescriptor(Mutex<Receiver>);

impl ChildSessionObserver for UnrelatedDescriptor {
    fn started(&self, _: u32) {
        panic!("the fixture must refuse authorization");
    }

    fn before_reap(&self, _: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        unreachable!()
    }

    fn record_anchor(&self, _: u32, _: u32) -> AnchorRecord<'_> {
        Box::pin(async {
            let mut byte = [0];
            let mut pipe = self.0.lock().await;
            let amount =
                tokio::time::timeout(std::time::Duration::from_secs(2), pipe.read(&mut byte))
                    .await
                    .map_err(io::Error::other)??;
            assert_eq!(
                amount, 0,
                "both live helpers must have closed the unrelated writer"
            );
            Err(io::Error::other("fixture observed EOF"))
        })
    }
}

#[tokio::test]
async fn the_real_launcher_and_anchor_drop_unrelated_inheritable_descriptors() {
    let (read, write) = io::pipe().unwrap();
    let observer = Arc::new(UnrelatedDescriptor(Mutex::new(
        Receiver::from_owned_fd(read.into()).unwrap(),
    )));
    let session = ChildSession::with_anchor(observer, env!("CARGO_BIN_EXE_cadencr-service").into());
    let mut command = session_command("/bin/false", Some(&session));
    command.stderr(Stdio::null());
    // SAFETY: only the child's inheritable bit on this fixture's writer changes.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(write.as_raw_fd(), libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let error = session.spawn(command).await.unwrap_err();
    assert!(error.to_string().contains("fixture observed EOF"));
}

#[derive(Default)]
struct Allow(AtomicBool);

impl ChildSessionObserver for Allow {
    fn started(&self, _: u32) {
        panic!("the owned launcher starts only after its recording callback");
    }

    fn before_reap(&self, _: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        unreachable!()
    }

    fn record_anchor(&self, _: u32, _: u32) -> AnchorRecord<'_> {
        Box::pin(async { Ok(()) })
    }

    fn launch_failed(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn the_owned_launcher_preserves_a_provider_exec_failure() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("uninstalled-provider");
    let non_executable = root.path().join("non-executable-provider");
    std::fs::write(&non_executable, "fixture").unwrap();
    std::fs::set_permissions(&non_executable, std::fs::Permissions::from_mode(0o600)).unwrap();
    for (program, expected) in [
        (missing, io::ErrorKind::NotFound),
        (non_executable, io::ErrorKind::PermissionDenied),
    ] {
        let observer = Arc::new(Allow::default());
        let session = ChildSession::with_anchor(
            observer.clone(),
            env!("CARGO_BIN_EXE_cadencr-service").into(),
        );
        let mut command = session_command(program, Some(&session));
        command.stderr(Stdio::null());
        let error = session.spawn(command).await.unwrap_err();
        assert_eq!(error.kind(), expected);
        assert!(observer.0.load(Ordering::SeqCst));
    }
}
