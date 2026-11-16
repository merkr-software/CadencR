-- Agent CLI processes the running service owns, so the next start can stop the
-- ones a killed service left behind (SIGKILL, power loss) before it resumes
-- their conversations: an orphan keeps working on the turn, and a resume next
-- to it would put two processes on the same provider session.
CREATE TABLE IF NOT EXISTS agent_process_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    -- When the operating system says this pid started:
    -- a pid the OS has since reused for another process never matches.
    identity TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
