use std::collections::HashSet;
use std::io;

use super::platform;

#[derive(Default)]
pub(super) struct Snapshot {
    pub(super) members: Vec<i32>,
    pub(super) exited: HashSet<i32>,
    pub(super) incomplete: bool,
}

pub(super) enum Observed {
    Live(i32),
    Exited,
    Vanished,
}

pub(super) fn members(leader: i32, excluded: Option<i32>) -> io::Result<Snapshot> {
    let mut snapshot = Snapshot::default();
    for pid in platform::pids()? {
        if pid <= 0 || Some(pid) == excluded {
            continue;
        }
        match platform::observe(pid)? {
            Observed::Live(sid) if sid == leader => snapshot.members.push(pid),
            Observed::Exited => {
                snapshot.exited.insert(pid);
            }
            Observed::Vanished => snapshot.incomplete = true,
            _ => {}
        }
    }
    Ok(snapshot)
}

pub(super) fn confirmed_empty(
    previous: &mut Option<HashSet<i32>>,
    snapshot: &mut Snapshot,
) -> bool {
    // A listed process can fork after enumeration and then exit. A new
    // zombie or a vanished PID can conceal that handoff to an unlisted child.
    // Stable zombies have already been followed by a fresh enumeration.
    let complete = !snapshot.incomplete && snapshot.members.is_empty();
    let next = complete.then(|| std::mem::take(&mut snapshot.exited));
    let same = next.is_some() && *previous == next;
    *previous = next;
    same
}
