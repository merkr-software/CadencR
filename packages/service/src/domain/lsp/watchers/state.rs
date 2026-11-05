//! Atomic registration state and native OS watcher ownership.
use super::registration::{Rule, MAX_RULES};
use super::{events, Change, Inner, MAX_REGISTRATIONS};
use notify_debouncer_mini::notify::{self, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, PoisonError, RwLock,
};
use tokio::sync::mpsc;

struct EventQueue {
    tx: mpsc::Sender<notify::Result<notify::Event>>,
    filter: Arc<RwLock<Vec<Rule>>>,
    overflow: Arc<AtomicBool>,
}
impl EventQueue {
    fn send(&self, event: notify::Result<notify::Event>) {
        if let Ok(event) = &event {
            // Rescans and oversized events must reach the consumer as failures.
            if !event.need_rescan() && event.paths.len() <= 256 {
                let filter = self.filter.read().unwrap_or_else(PoisonError::into_inner);
                if !events::changes(event.clone())
                    .iter()
                    .any(|(path, kind)| filter.iter().any(|rule| rule.matches(path, *kind)))
                {
                    return;
                }
            }
        }
        if self.tx.try_send(event).is_err() {
            self.overflow.store(true, Ordering::Relaxed);
        }
    }
}

impl Inner {
    pub(super) fn ensure_watcher(&mut self) -> Result<(), String> {
        if self.watcher.is_some() {
            return Ok(());
        }
        let queue = EventQueue {
            tx: self.tx.clone(),
            filter: self.filter.clone(),
            overflow: self.overflow.clone(),
        };
        let mut watcher = notify::RecommendedWatcher::new(
            move |event| queue.send(event),
            notify::Config::default().with_follow_symlinks(false),
        )
        .map_err(|e| format!("Could not create language-server file watcher: {e}"))?;
        for root in &self.roots {
            watcher.watch(root, RecursiveMode::Recursive).map_err(|e| {
                crate::shared::watch_limits::describe_watch_error(
                    "Could not watch LSP workspace",
                    &e,
                )
            })?;
        }
        self.watcher = Some(watcher);
        Ok(())
    }
    pub(super) fn commit(&mut self, change: Change) -> Result<(), String> {
        validate(&self.active, &change)?;
        match change {
            Change::Add(entries) => {
                for (id, rules) in entries {
                    self.active.insert(id, rules);
                }
            }
            Change::Remove(ids) => {
                for id in ids {
                    self.active.remove(&id);
                }
            }
        }
        *self.filter.write().unwrap_or_else(PoisonError::into_inner) =
            self.active.values().flatten().cloned().collect();
        self.release_unused();
        Ok(())
    }
    pub(super) fn release_unused(&mut self) {
        if self.active.is_empty() && self.pending.is_empty() {
            self.watcher = None;
        }
    }
}
pub(super) fn validate(active: &HashMap<String, Vec<Rule>>, change: &Change) -> Result<(), String> {
    let mut next = active.clone();
    match change {
        Change::Add(entries) => {
            for (id, rules) in entries {
                next.insert(id.clone(), rules.clone());
            }
        }
        Change::Remove(ids) => {
            for id in ids {
                next.remove(id);
            }
        }
    }
    if next.len() > MAX_REGISTRATIONS || next.values().map(Vec::len).sum::<usize>() > MAX_RULES {
        return Err("Language-server file watcher limit reached".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::registration::compile;
    use super::*;
    use notify::{event::ModifyKind, Event, EventKind};
    use serde_json::json;

    #[test]
    fn unrelated_churn_does_not_consume_queue_capacity_and_filter_updates_are_live() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let rules = |pattern| {
            compile(
                json!({"watchers":[{"globPattern":pattern,"kind":2}]}),
                &[root.clone()],
            )
            .unwrap()
        };
        let filter = Arc::new(RwLock::new(rules("**/*.ts")));
        let overflow = Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = mpsc::channel(128);
        let queue = EventQueue {
            tx,
            filter: filter.clone(),
            overflow: overflow.clone(),
        };
        let event =
            |name| Ok(Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join(name)));
        for _ in 0..1024 {
            queue.send(event("unrelated.txt"));
        }
        assert!(rx.try_recv().is_err());
        assert!(!overflow.load(Ordering::Relaxed));
        queue.send(event("actual.ts"));
        assert!(rx.try_recv().is_ok());
        *filter.write().unwrap() = rules("**/*.txt");
        queue.send(event("actual.ts"));
        assert!(rx.try_recv().is_err());
        queue.send(event("now-related.txt"));
        assert!(rx.try_recv().is_ok());
        assert!(!overflow.load(Ordering::Relaxed));
    }
}
