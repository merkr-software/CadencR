//! Relay newline-delimited ACP while the agent, client, and tools can all reply.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::process::{ExitCode, ExitStatus, Stdio};
use std::time::Duration;

use cadencr_provider_sdk::ProviderError;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::time::Instant;

use crate::cli;
use crate::config::ConfigMapper;
use crate::events::{EventMapper, SubagentTracker};

const STOP_GRACE: Duration = Duration::from_secs(1);
const SUBAGENT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const SUBAGENT_IDLE_INTERVAL: Duration = Duration::from_secs(4);

#[derive(Default)]
struct FrameMapper {
    config: ConfigMapper,
    events: EventMapper,
}

pub async fn run(binary: &Path, args: &[OsString]) -> Result<ExitCode, ProviderError> {
    let mut command = cli::command(binary);
    command
        .arg("acp")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // Inherit the service's managed process group, so host shutdown also
    // reaches agy and its workers if the connector itself cannot respond.
    let mut child = command.spawn().map_err(|error| {
        ProviderError::new(format!(
            "Could not start Antigravity CLI (`agy acp`): {error}"
        ))
    })?;
    let (Some(child_input), Some(child_output)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(ProviderError::new(
            "Antigravity CLI stdio pipes were unavailable.",
        ));
    };
    let state = RefCell::new(FrameMapper::default());
    let mut host_output = tokio::io::stdout();
    let result = tokio::select! {
        result = relay_lines(tokio::io::stdin(), child_input, "Cadencr", |message| {
            let mut state = state.borrow_mut();
            state.config.map_host(message);
            state.events.map_host(message);
        }) => result.map(|()| false),
        result = relay_agent(child_output, &mut host_output, &state, SubagentTracker::new(args)) => result.map(|()| true),
        result = stop_signal() => result.map(|()| false),
    };
    let status = stop_child(&mut child).await;
    if result? {
        return Err(ProviderError::new(format!(
            "Antigravity CLI closed the ACP connection ({}).",
            status?
        )));
    }
    status?;
    Ok(ExitCode::SUCCESS)
}

async fn relay_agent(
    reader: impl AsyncRead + Unpin,
    mut writer: impl AsyncWrite + Unpin,
    state: &RefCell<FrameMapper>,
    tracker: SubagentTracker,
) -> io::Result<()> {
    let mut lines = BufReader::new(reader).lines();
    let mut poll = tokio::time::interval(SUBAGENT_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut tracker = Some(tracker);
    let mut reading = None::<tokio::task::JoinHandle<(SubagentTracker, Vec<Value>)>>;
    let mut queued = VecDeque::new();
    let mut delay = SUBAGENT_POLL_INTERVAL;
    let mut next_poll = Instant::now();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { return Ok(()) };
                if line.trim().is_empty() {
                    continue;
                }
                let mut message = parse_message(&line, "Antigravity")?;
                {
                    let mut state = state.borrow_mut();
                    state.config.map_agent(&mut message);
                    state.events.map_agent(&mut message);
                }
                write_message(&mut writer, &message).await?;
            }
            result = async {
                match reading.as_mut() {
                    Some(task) => task.await,
                    None => std::future::pending().await,
                }
            } => {
                let (finished, frames) = result.map_err(io::Error::other)?;
                reading = None;
                delay = if frames.is_empty() && !finished.has_pending_launches() {
                    (delay * 2).min(SUBAGENT_IDLE_INTERVAL)
                } else {
                    SUBAGENT_POLL_INTERVAL
                };
                next_poll = Instant::now() + delay;
                tracker = Some(finished);
                queued.extend(frames);
            }
            () = std::future::ready(()), if !queued.is_empty() => {
                if let Some(frame) = queued.pop_front() {
                    let forward = state.borrow().events.can_forward_subagent(&frame);
                    if forward { write_message(&mut writer, &frame).await?; }
                }
            }
            _ = poll.tick() => {
                if let Some(mut current) = tracker.take() {
                    let operations = state.borrow_mut().events.take_subagent_operations();
                    if operations.is_empty()
                        && (current.is_idle() || !queued.is_empty() || Instant::now() < next_poll)
                    {
                        tracker = Some(current);
                    } else {
                        reading = Some(tokio::task::spawn_blocking(move || {
                            let frames = current.poll(operations);
                            (current, frames)
                        }));
                    }
                }
            }
        }
    }
}

async fn relay_lines<R, W>(
    reader: R,
    mut writer: W,
    sender: &str,
    mut map: impl FnMut(&mut Value),
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let mut message = parse_message(&line, sender)?;
        map(&mut message);
        write_message(&mut writer, &message).await?;
    }
    Ok(())
}

fn parse_message(line: &str, sender: &str) -> io::Result<Value> {
    serde_json::from_str(line).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{sender} sent an invalid ACP message: {error}"),
        )
    })
}

async fn write_message(writer: &mut (impl AsyncWrite + Unpin), message: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await
}

async fn stop_child(child: &mut Child) -> io::Result<ExitStatus> {
    // Closing stdin lets agy save session state and exit normally.
    match tokio::time::timeout(STOP_GRACE, child.wait()).await {
        Ok(result) => result,
        Err(_) => {
            child.kill().await?;
            child.wait().await
        }
    }
}

#[cfg(unix)]
async fn stop_signal() -> io::Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = terminate.recv() => (),
        _ = interrupt.recv() => (),
    }
    Ok(())
}

#[cfg(not(unix))]
async fn stop_signal() -> io::Result<()> {
    tokio::signal::ctrl_c().await
}
