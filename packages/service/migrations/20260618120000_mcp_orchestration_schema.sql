CREATE TABLE IF NOT EXISTS agent_message_origins (
    message_id INTEGER PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
    origin_kind TEXT NOT NULL CHECK (
        origin_kind IN ('human', 'session_generated', 'system_generated', 'imported')
    ),
    source_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
    source_feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
    source_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    source_message_id INTEGER REFERENCES agent_messages(id) ON DELETE SET NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_message_origins_source_session
ON agent_message_origins(source_session_id);

CREATE INDEX IF NOT EXISTS idx_agent_message_origins_source_feature
ON agent_message_origins(source_feature_id);

CREATE INDEX IF NOT EXISTS idx_agent_message_origins_source_project
ON agent_message_origins(source_project_id);

CREATE TABLE IF NOT EXISTS agent_session_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    target_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL CHECK (
        link_type IN ('spawned', 'messaged', 'referenced', 'handoff')
    ),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_session_links_source
ON agent_session_links(source_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_session_links_target
ON agent_session_links(target_session_id, created_at);

CREATE TABLE IF NOT EXISTS mcp_tool_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    source_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
    source_feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
    source_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    target_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
    target_feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
    target_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    result_size_bytes INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_log_source
ON mcp_tool_audit_log(source_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_log_target
ON mcp_tool_audit_log(target_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_log_tool_created
ON mcp_tool_audit_log(tool_name, created_at);

CREATE TABLE IF NOT EXISTS agent_session_message_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    source_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'delivering', 'delivered', 'error', 'cancelled')
    ),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_session_message_queue_target_status
ON agent_session_message_queue(target_session_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_session_message_queue_source
ON agent_session_message_queue(source_session_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_messages_fts USING fts5(
    content,
    content='agent_messages',
    content_rowid='id',
    tokenize='unicode61'
);

INSERT INTO agent_messages_fts(agent_messages_fts) VALUES('rebuild');

CREATE TRIGGER IF NOT EXISTS agent_messages_ai AFTER INSERT ON agent_messages BEGIN
    INSERT INTO agent_messages_fts(rowid, content)
    VALUES (new.id, COALESCE(new.content, ''));
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_ad AFTER DELETE ON agent_messages BEGIN
    INSERT INTO agent_messages_fts(agent_messages_fts, rowid, content)
    VALUES('delete', old.id, COALESCE(old.content, ''));
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_au AFTER UPDATE OF content ON agent_messages BEGIN
    INSERT INTO agent_messages_fts(agent_messages_fts, rowid, content)
    VALUES('delete', old.id, COALESCE(old.content, ''));
    INSERT INTO agent_messages_fts(rowid, content)
    VALUES (new.id, COALESCE(new.content, ''));
END;
