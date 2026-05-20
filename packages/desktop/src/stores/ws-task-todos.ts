import type { AgentBlockData } from "@/components/AgentBlock";
import { isTaskTodoTool } from "@/lib/tool-adapter";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import type { TodoItem } from "@/types/agent";

interface TaskTodo extends TodoItem {
  id: string;
}

interface ParsedTodos {
  todos: TodoItem[];
  lastIndex: number;
}

export function parseTaskTodosFromBlocks(blocks: AgentBlockData[]): ParsedTodos | undefined {
  const allBlocks = flattenBlocks(blocks);
  const taskById = new Map<string, TaskTodo>();
  const createToolUseToTaskId = new Map<string, string>();
  let sawTaskTool = false;
  let lastIndex = -1;

  allBlocks.forEach((block, index) => {
    if (block.type === "tool_call" && block.toolName === "TaskCreate") {
      sawTaskTool = true;
      lastIndex = index;
      handleTaskCreate(block, taskById, createToolUseToTaskId);
      return;
    }
    if (block.type === "tool_call" && block.toolName === "TaskUpdate") {
      sawTaskTool = true;
      lastIndex = index;
      handleTaskUpdate(block, taskById);
      return;
    }
    if (block.type === "tool_result" && block.toolUseId) {
      handleTaskCreateResult(block, taskById, createToolUseToTaskId);
    }
  });

  if (!sawTaskTool) return undefined;
  return {
    todos: [...taskById.values()].map(({ content, status, activeForm }) => ({
      content,
      status,
      activeForm,
    })),
    lastIndex,
  };
}

export function taskTodoMutationSeen(block: AgentBlockData): boolean {
  if (block.type === "tool_call") return isTaskTodoTool(block.toolName);
  return false;
}

function flattenBlocks(blocks: AgentBlockData[]): AgentBlockData[] {
  return blocks.flatMap((block) => (block.childBlocks ? [block, ...block.childBlocks] : [block]));
}

function handleTaskCreate(
  block: AgentBlockData,
  taskById: Map<string, TaskTodo>,
  createToolUseToTaskId: Map<string, string>,
): void {
  const input = parseToolArgsObject(block.toolArgs || block.content);
  if (!input) return;
  const fallbackId = block.toolUseId ?? block.id;
  const id = stringArg(input, "id", "taskId") ?? fallbackId;
  const content = stringArg(input, "subject", "content") ?? "";
  const activeForm = stringArg(input, "activeForm") ?? "";
  const parsedStatus = todoStatus(input.status);
  const status = parsedStatus && parsedStatus !== "deleted" ? parsedStatus : "pending";
  taskById.set(id, { id, content, activeForm, status });
  if (block.toolUseId) createToolUseToTaskId.set(block.toolUseId, id);
}

function handleTaskCreateResult(
  block: AgentBlockData,
  taskById: Map<string, TaskTodo>,
  createToolUseToTaskId: Map<string, string>,
): boolean {
  const provisionalId = createToolUseToTaskId.get(block.toolUseId ?? "");
  if (!provisionalId) return false;
  const authoritativeId = taskIdFromTaskCreateResult(block.content);
  if (!authoritativeId || authoritativeId === provisionalId) return true;
  const todo = taskById.get(provisionalId);
  if (!todo) return true;
  taskById.delete(provisionalId);
  taskById.set(authoritativeId, { ...todo, id: authoritativeId });
  createToolUseToTaskId.set(block.toolUseId ?? "", authoritativeId);
  return true;
}

function handleTaskUpdate(block: AgentBlockData, taskById: Map<string, TaskTodo>): void {
  const input = parseToolArgsObject(block.toolArgs || block.content);
  if (!input) return;
  const id = stringArg(input, "taskId", "id");
  if (!id) return;
  const status = todoStatus(input.status);
  if (status === "deleted") {
    taskById.delete(id);
    return;
  }
  const existing = taskById.get(id);
  if (!existing) return;
  taskById.set(id, {
    ...existing,
    content: stringArg(input, "subject", "content") ?? existing.content,
    activeForm: stringArg(input, "activeForm") ?? existing.activeForm,
    status: status ?? existing.status,
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function taskIdFromRecord(input: Record<string, unknown>): string | undefined {
  return stringArg(input, "id", "taskId") ?? nestedTaskId(input.task);
}

function taskIdFromTaskCreateResult(content: string): string | undefined {
  const parsed = parseUnknown(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return taskIdFromRecord(parsed as Record<string, unknown>);
  }
  return stringValue(parsed)
    ? taskIdFromTextResult(parsed as string)
    : taskIdFromTextResult(content);
}

function parseUnknown(json: string | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function taskIdFromTextResult(text: string): string | undefined {
  const match = /\bTask #([^\s:]+) created successfully\b/.exec(text);
  return match?.[1];
}

function nestedTaskId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return taskIdFromRecord(value as Record<string, unknown>);
}

function todoStatus(value: unknown): TodoItem["status"] | "deleted" | undefined {
  return value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "deleted"
    ? value
    : undefined;
}
