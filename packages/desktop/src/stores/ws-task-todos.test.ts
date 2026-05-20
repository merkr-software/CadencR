import { describe, expect, it } from "vitest";
import type { AgentBlockData } from "@/components/AgentBlock";
import { buildMessagePatch, parseTodosFromBlocks } from "./ws-block-mutations";

function toolCall(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  toolUseId?: string,
): AgentBlockData {
  return {
    id,
    type: "tool_call",
    content: JSON.stringify(args),
    toolArgs: JSON.stringify(args),
    toolName,
    ...(toolUseId ? { toolUseId } : {}),
  };
}

function toolResult(toolUseId: string, content: Record<string, unknown>): AgentBlockData {
  return {
    id: `result-${toolUseId}`,
    type: "tool_result",
    content: JSON.stringify(content),
    isError: false,
    sourceToolName: "TaskCreate",
    toolUseId,
  };
}

function todoWrite(todos: Array<Record<string, unknown>>): AgentBlockData {
  return toolCall("todo-write-1", "TodoWrite", { todos }, "todo-write-tool-1");
}

describe("TaskCreate and TaskUpdate todo extraction", () => {
  it("reconstructs todos from TaskCreate result IDs and TaskUpdate patches", () => {
    const blocks: AgentBlockData[] = [
      toolCall(
        "create-1",
        "TaskCreate",
        { subject: "Write replay tests", activeForm: "Writing replay tests" },
        "create-tool-1",
      ),
      toolResult("create-tool-1", { id: "task-1" }),
      toolCall(
        "update-1",
        "TaskUpdate",
        { taskId: "task-1", status: "in_progress", activeForm: "Implementing replay" },
        "update-tool-1",
      ),
      toolCall(
        "create-2",
        "TaskCreate",
        { subject: "Add task todos", activeForm: "Adding task todos" },
        "create-tool-2",
      ),
      toolResult("create-tool-2", { taskId: "task-2" }),
      toolCall(
        "update-2",
        "TaskUpdate",
        { taskId: "task-2", subject: "Add TaskCreate todos", status: "completed" },
        "update-tool-2",
      ),
    ];

    expect(parseTodosFromBlocks(blocks)).toEqual([
      {
        content: "Write replay tests",
        status: "in_progress",
        activeForm: "Implementing replay",
      },
      {
        content: "Add TaskCreate todos",
        status: "completed",
        activeForm: "Adding task todos",
      },
    ]);
  });

  it("removes deleted TaskUpdate todos", () => {
    const blocks: AgentBlockData[] = [
      toolCall("create-1", "TaskCreate", { subject: "Remove me" }, "create-tool-1"),
      toolResult("create-tool-1", { id: "task-1" }),
      toolCall("update-1", "TaskUpdate", { taskId: "task-1", status: "deleted" }),
    ];

    expect(parseTodosFromBlocks(blocks)).toEqual([]);
  });

  it("does not let a TaskCreate result override a later TodoWrite snapshot", () => {
    const blocks: AgentBlockData[] = [
      toolCall("create-1", "TaskCreate", { subject: "Older task" }, "create-tool-1"),
      todoWrite([
        {
          content: "Latest TodoWrite task",
          status: "completed",
          activeForm: "Finishing latest task",
        },
      ]),
      toolResult("create-tool-1", { id: "task-1" }),
    ];

    expect(parseTodosFromBlocks(blocks)).toEqual([
      {
        content: "Latest TodoWrite task",
        status: "completed",
        activeForm: "Finishing latest task",
      },
    ]);
  });

  it("uses nested TaskCreate result IDs so TaskUpdate can patch created todos", () => {
    const blocks: AgentBlockData[] = [
      toolCall(
        "create-1",
        "TaskCreate",
        { subject: "Initial task", activeForm: "Doing initial task" },
        "create-tool-1",
      ),
      toolResult("create-tool-1", { task: { id: "task-1", subject: "Initial task" } }),
      toolCall(
        "update-1",
        "TaskUpdate",
        {
          taskId: "task-1",
          subject: "Renamed task",
          status: "completed",
          activeForm: "Finishing renamed task",
        },
        "update-tool-1",
      ),
    ];

    expect(parseTodosFromBlocks(blocks)).toEqual([
      {
        content: "Renamed task",
        status: "completed",
        activeForm: "Finishing renamed task",
      },
    ]);
  });

  it("uses Claude text TaskCreate result IDs so TaskUpdate can patch created todos", () => {
    const blocks: AgentBlockData[] = [
      toolCall(
        "create-1",
        "TaskCreate",
        { subject: "Initial task", activeForm: "Doing initial task" },
        "create-tool-1",
      ),
      {
        id: "result-create-tool-1",
        type: "tool_result",
        content: "Task #1 created successfully: Initial task",
        isError: false,
        sourceToolName: "TaskCreate",
        toolUseId: "create-tool-1",
      },
      toolCall(
        "update-1",
        "TaskUpdate",
        {
          taskId: "1",
          subject: "Renamed task",
          status: "completed",
          activeForm: "Finishing renamed task",
        },
        "update-tool-1",
      ),
    ];

    expect(parseTodosFromBlocks(blocks)).toEqual([
      {
        content: "Renamed task",
        status: "completed",
        activeForm: "Finishing renamed task",
      },
    ]);
  });

  it("deletes todos when TaskUpdate references Claude text result task IDs", () => {
    const blocks: AgentBlockData[] = [
      toolCall("create-1", "TaskCreate", { subject: "Remove me" }, "create-tool-1"),
      {
        id: "result-create-tool-1",
        type: "tool_result",
        content: "Task #1 created successfully: Remove me",
        isError: false,
        sourceToolName: "TaskCreate",
        toolUseId: "create-tool-1",
      },
      toolCall("update-1", "TaskUpdate", { taskId: "1", status: "deleted" }),
    ];

    expect(parseTodosFromBlocks(blocks)).toEqual([]);
  });

  it("updates todos when a TaskUpdate block receives input_json_delta mutations", () => {
    const create = toolCall(
      "create-1",
      "TaskCreate",
      { subject: "Initial task", activeForm: "Doing initial task" },
      "create-tool-1",
    );
    const result = toolResult("create-tool-1", { task: { id: "task-1", subject: "Initial task" } });
    const update = toolCall(
      "update-1",
      "TaskUpdate",
      { taskId: "task-1", status: "completed", subject: "Renamed task" },
      "update-tool-1",
    );

    const patch = buildMessagePatch(
      [create, result, update],
      [{ action: "update", block: { id: update.id, type: "tool_call", content: update.content } }],
      {
        enterPlanModeRequested: false,
      },
    );

    expect(patch.todos).toEqual([
      {
        content: "Renamed task",
        status: "completed",
        activeForm: "Doing initial task",
      },
    ]);
  });
});
