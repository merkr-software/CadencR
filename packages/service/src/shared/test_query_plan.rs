//! `EXPLAIN QUERY PLAN` assertions for queries that depend on an index.
//!
//! A missing index does not always show up as `SCAN <table>`: SQLite prints a
//! correlated subquery that walks a whole table as a bare `SEARCH <alias>`
//! (no `USING ...`), and an `AUTOMATIC` index is built by scanning the table
//! on every run. All of these are full scans, so all fail here.

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

/// Single-connection in-memory pool carrying the real migrated schema, so the
/// plan is the one production gets.
pub(crate) async fn migrated_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::shared::migrate::run_migrations(&crate::shared::migrate::MigrationContext::pool_only(
        &pool,
    ))
    .await
    .unwrap();
    pool
}

/// Forge `ANALYZE` statistics (`(index, stat)` pairs for `table`) so the
/// planner sees the cost model another SQLite version or a real `ANALYZE` may
/// produce. A query that must keep its index has to survive this.
pub(crate) async fn forge_index_stats(pool: &SqlitePool, table: &str, stats: &[(&str, &str)]) {
    sqlx::query("ANALYZE sqlite_schema")
        .execute(pool)
        .await
        .unwrap();
    for (index, stat) in stats {
        sqlx::query("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)")
            .bind(table)
            .bind(index)
            .bind(stat)
            .execute(pool)
            .await
            .unwrap();
    }
    // Reloads the statistics into the planner.
    sqlx::query("ANALYZE sqlite_schema")
        .execute(pool)
        .await
        .unwrap();
}

/// The `detail` column of `EXPLAIN QUERY PLAN` rows, one line per step.
pub(crate) fn plan_details(rows: &[(i64, i64, i64, String)]) -> String {
    rows.iter()
        .map(|(_, _, _, detail)| detail.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Fail on any full table scan. `allowed_scans` names the CTEs and `VALUES`
/// lists the query walks on purpose.
pub(crate) fn assert_no_full_scan(details: &str, allowed_scans: &[&str]) {
    for line in details.lines() {
        let mut words = line.split_whitespace();
        let (Some(step), Some(target)) = (words.next(), words.next()) else {
            continue;
        };
        let rest = words.collect::<Vec<_>>().join(" ");
        // `SCAN 3-ROW VALUES CLAUSE` / `SCAN CONSTANT ROW` read no table.
        if rest.contains("VALUES CLAUSE") || line.contains("CONSTANT ROW") {
            continue;
        }
        match step {
            "SCAN" => assert!(
                allowed_scans.contains(&target),
                "full scan of `{target}`:\n{details}"
            ),
            "SEARCH" => assert!(
                rest.starts_with("USING ") && !rest.contains("AUTOMATIC"),
                "`SEARCH {target}` without a stored index walks the whole table:\n{details}"
            ),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::assert_no_full_scan;

    #[test]
    fn accepts_indexed_searches_and_allowed_scans() {
        assert_no_full_scan(
            "MATERIALIZE activity\nSEARCH f USING INDEX idx (status=?)\nSCAN activity\n\
             SEARCH s USING COVERING INDEX idx_s (feature_id=?)\nUSE TEMP B-TREE FOR ORDER BY",
            &["activity"],
        );
    }

    #[test]
    #[should_panic(expected = "without a stored index")]
    fn rejects_a_bare_correlated_search() {
        assert_no_full_scan("SEARCH f USING INDEX idx (status=?)\nSEARCH s", &[]);
    }

    #[test]
    #[should_panic(expected = "without a stored index")]
    fn rejects_an_automatic_index() {
        assert_no_full_scan(
            "SEARCH s USING AUTOMATIC COVERING INDEX (feature_id=?)",
            &[],
        );
    }

    #[test]
    #[should_panic(expected = "full scan of `agent_sessions`")]
    fn rejects_a_table_scan() {
        assert_no_full_scan("SCAN agent_sessions", &[]);
    }
}
