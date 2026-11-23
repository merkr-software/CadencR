//! Aggregate serialized-byte budgeting for hydrated block trees.

use std::io::{self, Write};

use super::super::models::AgentBlock;
use super::pagination::block_message_id;

pub(super) const SESSION_WIRE_SOFT_CAP_BYTES: usize = 1024 * 1024;

/// Drop oldest blocks while retaining the newest top-level anchor. Returns the
/// greatest dropped message id for backwards-pagination cursor construction.
pub(super) fn trim_blocks_to_byte_cap(blocks: &mut Vec<AgentBlock>, cap: usize) -> Option<i64> {
    let mut max_dropped = None;
    while let Some(excess) = excess_bytes(blocks, cap) {
        if trim_oldest_at_any_depth(blocks, excess, true, &mut max_dropped) == 0 {
            break;
        }
    }
    max_dropped
}

/// Drop newest blocks while retaining the oldest top-level anchor. Incremental
/// hydration uses the first dropped id as its next forward cursor, so no
/// omitted row is skipped.
pub(super) fn trim_newest_blocks_to_byte_cap(
    blocks: &mut Vec<AgentBlock>,
    cap: usize,
) -> Option<i64> {
    let mut min_dropped = None;
    while let Some(excess) = excess_bytes(blocks, cap) {
        if trim_newest_at_any_depth(blocks, excess, true, &mut min_dropped) == 0 {
            break;
        }
    }
    min_dropped
}

fn excess_bytes(blocks: &[AgentBlock], cap: usize) -> Option<usize> {
    serialized_len(blocks)
        .checked_sub(cap)
        .filter(|excess| *excess > 0)
}

fn serialized_len(value: &(impl serde::Serialize + ?Sized)) -> usize {
    let mut writer = CountingWriter::default();
    serde_json::to_writer(&mut writer, value).map_or(usize::MAX, |_| writer.bytes)
}

#[derive(Default)]
struct CountingWriter {
    bytes: usize,
}

impl Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buf.len());
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn trim_oldest_at_any_depth(
    blocks: &mut Vec<AgentBlock>,
    mut bytes_to_remove: usize,
    preserve_one: bool,
    max_dropped: &mut Option<i64>,
) -> usize {
    let mut removed_bytes = 0usize;
    let removable = blocks.len().saturating_sub(usize::from(preserve_one));
    let mut drop_count = 0usize;
    for block in blocks.iter().take(removable) {
        removed_bytes = removed_bytes.saturating_add(serialized_len(block) + 1);
        drop_count += 1;
        if removed_bytes >= bytes_to_remove {
            break;
        }
    }
    for removed in blocks.drain(0..drop_count) {
        visit_message_ids(&removed, &mut |id| {
            *max_dropped = Some(max_dropped.map_or(id, |current| current.max(id)));
        });
    }
    if removed_bytes >= bytes_to_remove {
        return removed_bytes;
    }
    bytes_to_remove -= removed_bytes;
    let nested = blocks
        .first_mut()
        .and_then(|block| block.child_blocks.as_mut())
        .map_or(0, |children| {
            trim_oldest_at_any_depth(children, bytes_to_remove, false, max_dropped)
        });
    removed_bytes.saturating_add(nested)
}

fn trim_newest_at_any_depth(
    blocks: &mut Vec<AgentBlock>,
    mut bytes_to_remove: usize,
    preserve_one: bool,
    min_dropped: &mut Option<i64>,
) -> usize {
    let mut removed_bytes = 0usize;
    let removable = blocks.len().saturating_sub(usize::from(preserve_one));
    let mut drop_count = 0usize;
    for block in blocks.iter().rev().take(removable) {
        removed_bytes = removed_bytes.saturating_add(serialized_len(block) + 1);
        drop_count += 1;
        if removed_bytes >= bytes_to_remove {
            break;
        }
    }
    let drain_start = blocks.len().saturating_sub(drop_count);
    for removed in blocks.drain(drain_start..) {
        visit_message_ids(&removed, &mut |id| {
            *min_dropped = Some(min_dropped.map_or(id, |current| current.min(id)));
        });
    }
    if removed_bytes >= bytes_to_remove {
        return removed_bytes;
    }
    bytes_to_remove -= removed_bytes;
    let nested = blocks
        .first_mut()
        .and_then(|block| block.child_blocks.as_mut())
        .map_or(0, |children| {
            trim_newest_at_any_depth(children, bytes_to_remove, false, min_dropped)
        });
    removed_bytes.saturating_add(nested)
}

fn visit_message_ids(block: &AgentBlock, visit: &mut impl FnMut(i64)) {
    // A joined block also holds every row up to its last one: a page resuming
    // past its first row only would skip the rest.
    for id in block_message_id(block)
        .into_iter()
        .chain(block.last_message_id)
    {
        visit(id);
    }
    if let Some(children) = &block.child_blocks {
        for child in children {
            visit_message_ids(child, visit);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::make_root_block;
    use super::*;

    #[test]
    fn oldest_trim_bounds_the_page_and_returns_a_backwards_cursor() {
        let mut blocks: Vec<AgentBlock> = (1..=40)
            .map(|id| {
                let mut block = make_root_block(id);
                block.content = "x".repeat(64 * 1024);
                block
            })
            .collect();

        let max_dropped = trim_blocks_to_byte_cap(&mut blocks, SESSION_WIRE_SOFT_CAP_BYTES)
            .expect("oversized page should be trimmed");

        assert!(serialized_len(&blocks) <= SESSION_WIRE_SOFT_CAP_BYTES);
        assert_eq!(
            blocks.first().and_then(block_message_id),
            Some(max_dropped + 1)
        );
    }

    #[test]
    fn oldest_trim_resumes_past_every_row_joined_into_a_dropped_block() {
        // Each block joins ten text rows: ids 10..=19, 20..=29, …
        let mut blocks: Vec<AgentBlock> = (1..=40)
            .map(|n| {
                let mut block = make_root_block(n * 10);
                block.last_message_id = Some(n * 10 + 9);
                block.content = "x".repeat(64 * 1024);
                block
            })
            .collect();

        let max_dropped = trim_blocks_to_byte_cap(&mut blocks, SESSION_WIRE_SOFT_CAP_BYTES)
            .expect("oversized page should be trimmed");

        // The next `before` page ends at the last joined row, not the first.
        let first_kept = blocks.first().and_then(block_message_id).unwrap();
        assert_eq!(max_dropped + 1, first_kept);
    }

    #[test]
    fn trims_a_genuine_singleton_child_chain() {
        let mut leaf = make_root_block(40);
        leaf.content = "x".repeat(SESSION_WIRE_SOFT_CAP_BYTES + 1);
        for id in (1..40).rev() {
            let mut parent = make_root_block(id);
            parent.child_blocks = Some(vec![leaf]);
            leaf = parent;
        }
        let mut blocks = vec![leaf];

        let max_dropped = trim_blocks_to_byte_cap(&mut blocks, SESSION_WIRE_SOFT_CAP_BYTES)
            .expect("oversized descendant should be removable");

        assert_eq!(max_dropped, 40);
        assert!(serialized_len(&blocks) <= SESSION_WIRE_SOFT_CAP_BYTES);
        assert!(blocks[0].child_blocks.as_ref().unwrap().is_empty());
    }

    #[test]
    fn newest_trim_keeps_a_forward_cursor_before_every_dropped_block() {
        let mut blocks: Vec<AgentBlock> = (1..=40)
            .map(|id| {
                let mut block = make_root_block(id);
                block.content = "x".repeat(64 * 1024);
                block
            })
            .collect();

        let min_dropped = trim_newest_blocks_to_byte_cap(&mut blocks, SESSION_WIRE_SOFT_CAP_BYTES)
            .expect("oversized incremental page should be trimmed");

        assert!(serialized_len(&blocks) <= SESSION_WIRE_SOFT_CAP_BYTES);
        assert_eq!(
            blocks.last().and_then(block_message_id),
            Some(min_dropped - 1)
        );
    }
}
