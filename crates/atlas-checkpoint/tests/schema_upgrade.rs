//! Two openers racing a schema upgrade, against a real database file.
//!
//! The per-version upgrade paths are unit-tested beside the migrations in
//! `src/schema.rs`, where the migration SQL is in reach. What only a real file
//! can show is concurrency: two connections — a writer and a reader, or two
//! commands racing an open — both find the store behind and both try to
//! upgrade it. `migrate` serialises them with `BEGIN IMMEDIATE` and re-reads
//! the version inside the lock, so the loser must wait and then do nothing.
//!
//! The old-version store is produced by rewinding a current one: the objects a
//! migration created are dropped, their DDL kept so a test can put them back,
//! and the version stamp is lowered. That keeps this file free of a second copy
//! of the migration SQL.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::time::Duration;

use atlas_checkpoint::{Store, SCHEMA_VERSION};
use rusqlite::Connection;

/// A current store on disk, with no connection left open.
fn current_store(dir: &Path) -> PathBuf {
    let atlas = dir.join(".atlas");
    drop(Store::open(&atlas).expect("store opens"));
    atlas
}

fn raw(atlas: &Path) -> Connection {
    let conn = Connection::open(atlas.join("sessions.db")).unwrap();
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    conn
}

fn version_of(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("SELECT {column} FROM {table} LIMIT 0"))
        .is_ok()
}

/// The DDL that re-creates what V8–V10 added, captured before rewinding so the
/// "other process" in a race can finish the upgrade the way `migrate` would.
struct Rewound {
    restore: Vec<String>,
}

/// Rewind a current store to schema 7: drop V10's tables, V9's and V8's
/// columns (and the index that pins the V8 column), and stamp 7.
fn rewind_to_7(conn: &Connection) -> Rewound {
    let objects = [
        "usage_delta",
        "usage_cursor",
        "idx_usage_delta_recorded",
        "idx_session_activity",
    ];
    let mut restore = vec![
        "ALTER TABLE agent_session ADD COLUMN last_activity_at TEXT".to_string(),
        "ALTER TABLE file_touch ADD COLUMN sketch_after TEXT".to_string(),
    ];
    for name in objects {
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = ?1",
                [name],
                |r| r.get(0),
            )
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        restore.push(sql);
    }
    conn.execute_batch(
        "DROP INDEX idx_usage_delta_recorded; \
         DROP TABLE usage_delta; \
         DROP TABLE usage_cursor; \
         DROP INDEX idx_session_activity; \
         ALTER TABLE agent_session DROP COLUMN last_activity_at; \
         ALTER TABLE file_touch DROP COLUMN sketch_after; \
         PRAGMA user_version = 7;",
    )
    .unwrap();
    assert!(!has_column(conn, "file_touch", "sketch_after"));
    Rewound { restore }
}

/// Several openers released at once against a store two migrations behind.
/// Every one of them must succeed — the losers wait on the IMMEDIATE lock and
/// then find nothing to do — and the store ends up current exactly once.
#[test]
fn openers_racing_an_upgrade_all_succeed() {
    for round in 0..8 {
        let dir = tempfile::tempdir().unwrap();
        let atlas = current_store(dir.path());
        rewind_to_7(&raw(&atlas));

        let openers = 4;
        let barrier = Arc::new(Barrier::new(openers));
        let handles: Vec<_> = (0..openers)
            .map(|_| {
                let atlas = atlas.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    Store::open_reader(&atlas).map(|_| ())
                })
            })
            .collect();
        for handle in handles {
            handle
                .join()
                .unwrap()
                .unwrap_or_else(|e| panic!("round {round}: a racing opener failed: {e}"));
        }

        let conn = raw(&atlas);
        assert_eq!(version_of(&conn), SCHEMA_VERSION, "round {round}");
        assert!(
            has_column(&conn, "file_touch", "sketch_after"),
            "round {round}"
        );
        assert!(
            has_column(&conn, "agent_session", "last_activity_at"),
            "round {round}"
        );
        assert!(
            has_column(&conn, "usage_delta", "turn_seq"),
            "round {round}"
        );
    }
}

/// The re-check inside the lock, made observable.
///
/// An opener reads the stale version on its fast path and then blocks on the
/// IMMEDIATE lock another connection already holds. That connection finishes
/// the upgrade and then writes a row V8 would destroy (`DELETE FROM
/// import_progress`). When the opener gets the lock it must re-read the
/// version and do nothing; if it trusted its stale read it would re-run V8 and
/// silently wipe the row.
///
/// The ordering depends on a sleep: if the opener is slow to start it reads the
/// new version on its fast path instead, and the test still passes without
/// having exercised the lock. It never fails spuriously.
#[test]
fn an_opener_that_waited_on_the_lock_does_not_rerun_a_finished_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    let atlas = current_store(dir.path());
    let holder = raw(&atlas);
    let rewound = rewind_to_7(&holder);

    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let opener = std::thread::spawn(move || Store::open_reader(&atlas).map(|_| ()));
    // Long enough for the opener to take its fast-path read and park on the
    // lock; well inside the store's 5 s busy timeout.
    std::thread::sleep(Duration::from_millis(400));
    for sql in &rewound.restore {
        holder.execute_batch(sql).unwrap();
    }
    holder
        .execute_batch(&format!(
            "INSERT INTO import_progress (path, imported_size, updated_at) \
             VALUES ('/t.jsonl', 42, '2026-06-01T00:00:00Z'); \
             PRAGMA user_version = {SCHEMA_VERSION};"
        ))
        .unwrap();
    holder.execute_batch("COMMIT").unwrap();

    opener
        .join()
        .unwrap()
        .expect("the waiting opener must succeed, not fail on a busy or duplicate column");
    assert_eq!(version_of(&holder), SCHEMA_VERSION);
    let progress: i64 = holder
        .query_row("SELECT COUNT(*) FROM import_progress", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        progress, 1,
        "the opener re-ran V8 on a store that was already current"
    );
}
