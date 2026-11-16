//! Pure mapping from "these processes are listening" to "this feature holds
//! these ports". Kept free of IO so the ownership rules are directly testable.
//!
//! Attribution runs in two passes because the cheap signal decides whether the
//! expensive one is needed: [`resolve`] walks process ancestry, and only the
//! sockets it cannot claim ([`unresolved_pids`]) cost a working-directory
//! lookup before [`attribute`] finishes the job.

use std::collections::HashMap;

use super::models::{AllocatedPort, FeaturePorts, PortSource};
use super::scan::ListenSocket;

/// Guard against a process table snapshot, read while processes come and go,
/// producing a parent cycle.
const MAX_ANCESTRY_DEPTH: usize = 64;

/// A feature's worktree directory. Only worktree paths are used for
/// directory-based attribution: they are unique per feature, whereas several
/// features of the same project share the project root and could not be told
/// apart by cwd alone. This is the last resort, used when no live process
/// ancestry claims the port.
#[derive(Debug, Clone)]
pub struct FeatureDir {
    pub feature_id: i64,
    pub path: String,
}

/// Pids that name a feature outright, and how: the shell of each live feature
/// terminal and each live agent process. A listening process inherits the
/// claim of the nearest such ancestor.
pub type ProcessRoots = HashMap<i32, (i64, PortSource)>;

/// A listening socket with the process chain above it, plus the feature that
/// chain identifies when a live terminal or agent owns it.
pub struct ResolvedSocket<'a> {
    socket: &'a ListenSocket,
    chain: Vec<i32>,
    owner: Option<(i64, PortSource)>,
}

/// Claim every socket a live terminal or agent can account for. The chain is
/// kept so the directory pass can reuse it without walking the process table
/// a second time.
pub fn resolve<'a>(
    sockets: &'a [ListenSocket],
    parents: &HashMap<i32, i32>,
    roots: &ProcessRoots,
    service_pid: i32,
) -> Vec<ResolvedSocket<'a>> {
    sockets
        .iter()
        .map(|socket| {
            let chain = ancestry(socket.pid, parents, service_pid);
            let owner = chain.iter().find_map(|pid| roots.get(pid).copied());
            ResolvedSocket {
                socket,
                chain,
                owner,
            }
        })
        .collect()
}

/// Pids whose working directory is still needed to attribute a port, deduped so
/// the caller hands `lsof` each one once. Sockets already claimed by a terminal
/// or agent contribute nothing.
pub fn unresolved_pids(resolved: &[ResolvedSocket<'_>]) -> Vec<i32> {
    let mut seen = Vec::new();
    for entry in resolved {
        if entry.owner.is_some() {
            continue;
        }
        for pid in &entry.chain {
            if !seen.contains(pid) {
                seen.push(*pid);
            }
        }
    }
    seen
}

/// Group every attributable socket by feature, ordered by feature id and then
/// by port. Sockets no rule claims are dropped.
pub fn attribute(
    resolved: Vec<ResolvedSocket<'_>>,
    cwds: &HashMap<i32, String>,
    feature_dirs: &[FeatureDir],
) -> Vec<FeaturePorts> {
    let mut by_feature: HashMap<i64, Vec<AllocatedPort>> = HashMap::new();
    for entry in resolved {
        let Some((feature_id, source)) = entry
            .owner
            .or_else(|| owner_by_directory(&entry.chain, cwds, feature_dirs))
        else {
            continue;
        };
        let ports = by_feature.entry(feature_id).or_default();
        // A server usually binds the same port on both IPv4 and IPv6; the user
        // cares about the port, not the socket count.
        if ports
            .iter()
            .any(|existing| existing.port == entry.socket.port)
        {
            continue;
        }
        ports.push(AllocatedPort {
            port: entry.socket.port,
            pid: entry.socket.pid,
            process: entry.socket.command.clone(),
            source,
        });
    }

    let mut grouped: Vec<FeaturePorts> = by_feature
        .into_iter()
        .map(|(feature_id, mut ports)| {
            ports.sort_by_key(|port| port.port);
            FeaturePorts { feature_id, ports }
        })
        .collect();
    grouped.sort_by_key(|entry| entry.feature_id);
    grouped
}

/// Walk from `pid` towards pid 1, returning the chain including `pid` itself.
/// The walk stops at the service because our own ancestors (Electron, the
/// shell that started `pnpm dev`, launchd) say nothing about which feature a
/// process serves.
///
/// Processes outside the service tree are walked too: a server started by an
/// agent outlives the agent that started it and reparents to init, so refusing
/// to look at anything but our own descendants would drop it the moment the
/// session ends.
fn ancestry(pid: i32, parents: &HashMap<i32, i32>, service_pid: i32) -> Vec<i32> {
    let mut chain = Vec::new();
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY_DEPTH {
        if current <= 1 || current == service_pid {
            break;
        }
        chain.push(current);
        let Some(parent) = parents.get(&current) else {
            break;
        };
        current = *parent;
    }
    chain
}

/// All that is left of a server whose agent has since exited: the directory it
/// runs in. The nearest process to the socket wins, so a server that chdir'd
/// out of the worktree is still placed by the shell above it rather than the
/// other way round; ties within one process go to the deepest worktree, which
/// is what distinguishes a worktree nested inside another project's directory.
fn owner_by_directory(
    chain: &[i32],
    cwds: &HashMap<i32, String>,
    feature_dirs: &[FeatureDir],
) -> Option<(i64, PortSource)> {
    for pid in chain {
        let Some(cwd) = cwds.get(pid) else {
            continue;
        };
        let best = feature_dirs
            .iter()
            .filter(|dir| is_within_dir(cwd, &dir.path))
            .max_by_key(|dir| dir.path.len());
        if let Some(dir) = best {
            return Some((dir.feature_id, PortSource::Workspace));
        }
    }
    None
}

/// True when `path` is `dir` itself or lives inside it. Used to match a
/// process's cwd against a feature worktree — a dev server is commonly launched
/// from a subdirectory of the worktree (`packages/web`), not its root.
fn is_within_dir(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() {
        return false;
    }
    path == dir
        || path
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn socket(pid: i32, port: u16) -> ListenSocket {
        ListenSocket {
            pid,
            command: "node".into(),
            port,
        }
    }

    /// A machine to attribute against. Feature 7 owns `/w/feature-a`, the
    /// service is pid 100, and each test fills in only the signals it exercises.
    #[derive(Default)]
    struct Machine {
        parents: HashMap<i32, i32>,
        cwds: HashMap<i32, String>,
        roots: ProcessRoots,
        dirs: Vec<FeatureDir>,
    }

    impl Machine {
        fn with_feature_a() -> Self {
            Machine {
                dirs: vec![FeatureDir {
                    feature_id: 7,
                    path: "/w/feature-a".into(),
                }],
                ..Machine::default()
            }
        }

        fn attribute(&self, sockets: &[ListenSocket]) -> Vec<FeaturePorts> {
            let resolved = resolve(sockets, &self.parents, &self.roots, 100);
            attribute(resolved, &self.cwds, &self.dirs)
        }
    }

    #[test]
    fn attributes_a_terminal_descendant_by_shell_ancestry() {
        // service(100) -> shell(200) -> npm(300) -> node(400)
        let machine = Machine {
            parents: HashMap::from([(200, 100), (300, 200), (400, 300)]),
            roots: ProcessRoots::from([(200, (42_i64, PortSource::Terminal))]),
            ..Machine::with_feature_a()
        };

        let result = machine.attribute(&[socket(400, 5173)]);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].feature_id, 42);
        assert_eq!(result[0].ports[0].port, 5173);
        assert_eq!(result[0].ports[0].source, PortSource::Terminal);
    }

    #[test]
    fn attributes_a_server_the_agent_started_by_agent_ancestry() {
        // service(100) -> agent CLI(500) -> zsh(550) -> node(600), running in
        // the project root every feature shares: only ancestry can say which
        // conversation this belongs to.
        let machine = Machine {
            parents: HashMap::from([(500, 100), (550, 500), (600, 550)]),
            roots: ProcessRoots::from([(500, (42_i64, PortSource::Agent))]),
            cwds: HashMap::from([(600, "/repo".to_string())]),
            ..Machine::with_feature_a()
        };

        let result = machine.attribute(&[socket(600, 4321)]);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].feature_id, 42);
        assert_eq!(result[0].ports[0].source, PortSource::Agent);
    }

    #[test]
    fn attributes_a_server_orphaned_by_its_agent_through_its_worktree() {
        // The agent that started it has exited, so the server hangs off init
        // and nothing but its working directory identifies the feature.
        let machine = Machine {
            parents: HashMap::from([(600, 1)]),
            cwds: HashMap::from([(600, "/w/feature-a/packages/web".to_string())]),
            ..Machine::with_feature_a()
        };

        let result = machine.attribute(&[socket(600, 3000)]);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].feature_id, 7);
        assert_eq!(result[0].ports[0].source, PortSource::Workspace);
    }

    #[test]
    fn the_listening_process_places_the_port_before_any_ancestor_does() {
        // shell(200) sits in the longer-named worktree, node(400) in its own.
        // The nearer process must win, not the longer path.
        let machine = Machine {
            parents: HashMap::from([(400, 200), (200, 1)]),
            cwds: HashMap::from([
                (400, "/w/feature-a".to_string()),
                (200, "/w/feature-bbbbbbbb".to_string()),
            ]),
            dirs: vec![
                FeatureDir {
                    feature_id: 7,
                    path: "/w/feature-a".into(),
                },
                FeatureDir {
                    feature_id: 8,
                    path: "/w/feature-bbbbbbbb".into(),
                },
            ],
            ..Machine::default()
        };

        let result = machine.attribute(&[socket(400, 3000)]);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].feature_id, 7);
    }

    #[test]
    fn a_worktree_nested_in_another_wins_by_depth() {
        let machine = Machine {
            parents: HashMap::from([(400, 1)]),
            cwds: HashMap::from([(400, "/w/outer/inner/src".to_string())]),
            dirs: vec![
                FeatureDir {
                    feature_id: 7,
                    path: "/w/outer".into(),
                },
                FeatureDir {
                    feature_id: 8,
                    path: "/w/outer/inner".into(),
                },
            ],
            ..Machine::default()
        };

        let result = machine.attribute(&[socket(400, 3000)]);

        assert_eq!(result[0].feature_id, 8);
    }

    #[test]
    fn a_terminal_that_left_the_worktree_still_belongs_to_its_feature() {
        let machine = Machine {
            parents: HashMap::from([(200, 100), (400, 200)]),
            roots: ProcessRoots::from([(200, (42_i64, PortSource::Terminal))]),
            cwds: HashMap::from([(400, "/w/feature-a".to_string())]),
            ..Machine::with_feature_a()
        };

        let result = machine.attribute(&[socket(400, 8080)]);

        assert_eq!(result[0].feature_id, 42);
        assert_eq!(result[0].ports[0].source, PortSource::Terminal);
    }

    #[test]
    fn ignores_processes_that_belong_to_no_feature() {
        // Some other app: no shell or agent above it, and it runs nowhere near
        // a worktree.
        let machine = Machine {
            parents: HashMap::from([(900, 1)]),
            cwds: HashMap::from([(900, "/Users/someone".to_string())]),
            ..Machine::with_feature_a()
        };

        let result = machine.attribute(&[socket(900, 3000)]);

        assert!(result.is_empty());
    }

    #[test]
    fn the_service_itself_owns_no_port() {
        let machine = Machine::with_feature_a();

        assert!(machine.attribute(&[socket(100, 5005)]).is_empty());
    }

    #[test]
    fn collapses_the_dual_stack_sockets_of_one_server() {
        let machine = Machine {
            parents: HashMap::from([(200, 100), (400, 200)]),
            roots: ProcessRoots::from([(200, (42_i64, PortSource::Terminal))]),
            ..Machine::with_feature_a()
        };

        let result = machine.attribute(&[socket(400, 3000), socket(400, 3000)]);

        assert_eq!(result[0].ports.len(), 1);
    }

    #[test]
    fn only_unclaimed_chains_need_a_directory_lookup() {
        // service(100) -> shell(200) -> node(300), plus an orphan(900).
        let machine = Machine {
            parents: HashMap::from([(200, 100), (300, 200), (900, 1)]),
            roots: ProcessRoots::from([(200, (42_i64, PortSource::Terminal))]),
            ..Machine::with_feature_a()
        };
        let sockets = [socket(300, 3000), socket(900, 5000)];

        let resolved = resolve(&sockets, &machine.parents, &machine.roots, 100);

        assert_eq!(unresolved_pids(&resolved), vec![900]);
    }

    #[test]
    fn a_parent_cycle_cannot_hang_the_walk() {
        let parents = HashMap::from([(400, 401), (401, 400)]);

        assert_eq!(ancestry(400, &parents, 100).len(), MAX_ANCESTRY_DEPTH);
    }

    #[test]
    fn the_walk_stops_at_the_service() {
        let parents = HashMap::from([(400, 200), (200, 100), (100, 90)]);

        assert_eq!(ancestry(400, &parents, 100), vec![400, 200]);
    }

    #[test]
    fn is_within_dir_requires_a_path_boundary() {
        assert!(is_within_dir("/w/feature-a", "/w/feature-a"));
        assert!(is_within_dir("/w/feature-a/src", "/w/feature-a/"));
        assert!(!is_within_dir("/w/feature-abc", "/w/feature-a"));
        assert!(!is_within_dir("/w", "/w/feature-a"));
        assert!(!is_within_dir("/w/feature-a", ""));
    }
}
