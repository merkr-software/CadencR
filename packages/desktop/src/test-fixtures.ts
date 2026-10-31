/**
 * Mock data factories for renderer tests.
 * Each factory returns realistic data matching DB schema types.
 */

import type { CustomAction } from "./api/generated";
import type { ProjectRow, FeatureRow, AgentMessageRow, AgentSessionRow } from "./types/db-rows";

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

let _projectId = 1;

export function createMockProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
  const id = overrides.id ?? _projectId++;
  return {
    id,
    name: `Test Project ${id}`,
    path: `/home/user/projects/test-project-${id}`,
    created_at: "2024-01-01T00:00:00.000Z",
    model_session: null,
    branch_prefix: "feature/",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

let _featureId = 1;

export function createMockFeature(overrides: Partial<FeatureRow> = {}): FeatureRow {
  const id = overrides.id ?? _featureId++;
  return {
    id,
    project_id: 1,
    title: `Test Feature ${id}`,
    type: "ws-session",
    created_at: "2024-01-01T00:00:00.000Z",
    model_session: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AgentMessage
// ---------------------------------------------------------------------------

let _messageId = 1;

export function createMockAgentMessage(overrides: Partial<AgentMessageRow> = {}): AgentMessageRow {
  const id = overrides.id ?? _messageId++;
  return {
    id,
    session_id: 1,
    role: "assistant",
    content: "This is a test message.",
    message_type: "text",
    tool_name: null,
    tool_use_id: null,
    parent_tool_use_id: null,
    created_at: "2024-01-01T00:00:00.000Z",
    model: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AgentSession
// ---------------------------------------------------------------------------

let _sessionId = 1;

export function createMockAgentSession(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  const id = overrides.id ?? _sessionId++;
  return {
    id,
    feature_id: 1,
    agent_type: "session",
    runtime_session_id: null,
    status: "completed",
    started_at: "2024-01-01T00:00:00.000Z",
    ended_at: "2024-01-01T00:05:00.000Z",
    subprocess_id: null,
    model: "claude-opus-4-5",
    pending_questions: null,
    has_file_changes: 0,
    permission_mode: "acceptEdits",
    pending_permission: null,
    input_tokens: 1000,
    output_tokens: 500,
    context_window: 200000,
    was_compacted: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Diff mock factories
// ---------------------------------------------------------------------------

export interface MockDiffHunk {
  content: string;
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  changes: {
    type: "normal" | "insert" | "delete";
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
  }[];
}

export interface MockDiffFile {
  oldFileName: string;
  newFileName: string;
  hunks: MockDiffHunk[];
}

export function createMockDiffHunk(overrides: Partial<MockDiffHunk> = {}): MockDiffHunk {
  return {
    content: "@@ -1,3 +1,4 @@",
    oldStart: 1,
    newStart: 1,
    oldLines: 3,
    newLines: 4,
    changes: [
      { type: "normal", content: " line1", oldLineNumber: 1, newLineNumber: 1 },
      { type: "insert", content: "+added line", newLineNumber: 2 },
      { type: "normal", content: " line2", oldLineNumber: 2, newLineNumber: 3 },
      { type: "normal", content: " line3", oldLineNumber: 3, newLineNumber: 4 },
    ],
    ...overrides,
  };
}

export function createMockDiffFile(overrides: Partial<MockDiffFile> = {}): MockDiffFile {
  return {
    oldFileName: "src/example.ts",
    newFileName: "src/example.ts",
    hunks: [createMockDiffHunk()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Custom action
// ---------------------------------------------------------------------------

/** A project action that never ran, named after its id. */
export function createMockCustomAction(
  id: number,
  overrides: Partial<CustomAction> = {},
): CustomAction {
  return {
    id,
    name: `Action ${id}`,
    command: "true",
    created_at: "",
    updated_at: "",
    position: id,
    scope: "project",
    project_id: 1,
    run_in_terminal: false,
    variable_names: [],
    last_run: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset helpers (call in beforeEach to reset auto-increment counters)
// ---------------------------------------------------------------------------

export function resetMockIds() {
  _projectId = 1;
  _featureId = 1;
  _messageId = 1;
  _sessionId = 1;
}
