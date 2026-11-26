//! Recovery of a previous service's provider tree. The old direct child is
//! no longer ours to reap, so only live processes with verified ownership
//! can be targeted. Keep their exact OS identities across escalation.

use std::collections::HashMap;
use std::io;
use std::time::Duration;

use tokio::time::Instant;

use super::super::platform as table;
use super::platform::Target;

const GRACE: Duration = Duration::from_secs(2);

pub(crate) async fn stop_verified_tree(root: u32, identity: String) -> io::Result<bool> {
    let tree = tokio::task::spawn_blocking(move || capture(root, &identity))
        .await
        .map_err(io::Error::other)??;
    if tree.is_empty() {
        return Ok(false);
    }
    tracing::warn!(
        pid = root,
        processes = tree.len(),
        "stopping an orphaned agent process tree"
    );
    for target in &tree {
        // A refused TERM can still allow KILL. Verify cessation below.
        if let Err(error) = target.signal(libc::SIGTERM) {
            tracing::debug!(pid = root, %error, "orphaned process refused SIGTERM");
        }
    }
    if wait_for_exit(&tree).await? {
        return Ok(true);
    }
    let mut refused = None;
    for target in &tree {
        if let Err(error) = target.signal(libc::SIGKILL) {
            refused = Some(error);
        }
    }
    if wait_for_exit(&tree).await? {
        return Ok(true);
    }
    Err(refused.unwrap_or_else(|| io::Error::other("an owned orphaned process is still running")))
}

fn capture(root: u32, identity: &str) -> io::Result<Vec<Target>> {
    let pid = i32::try_from(root).map_err(io::Error::other)?;
    let Some(target) = Target::capture_if(pid, || {
        Ok(table::start_time(root).as_deref() == Some(identity))
    })?
    else {
        return Ok(Vec::new());
    };
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, links) in table::links()? {
        if links.ppid != pid && pid != root as i32 {
            children.entry(links.ppid).or_default().push(pid);
        }
    }
    let mut work = vec![(pid, target)];
    let mut settled = Vec::new();
    while let Some((parent_id, parent)) = work.pop() {
        for pid in children.remove(&parent_id).into_iter().flatten() {
            if let Some(child) = Target::capture_if(pid, || {
                let child_links = table::links_of(pid)?;
                Ok(child_links.is_some_and(|links| links.ppid == parent_id) && parent.live()?)
            })? {
                work.push((pid, child));
            }
        }
        settled.push(parent);
    }
    Ok(settled)
}

pub(super) async fn wait_for_exit(tree: &[Target]) -> io::Result<bool> {
    let deadline = Instant::now() + GRACE;
    loop {
        let live = tree.iter().try_fold(false, |live, target| {
            target.live().map(|running| live || running)
        })?;
        if !live {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}
