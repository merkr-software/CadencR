import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  diagnosticRecordsSchema,
  retainDiagnosticRecord,
  type DiagnosticRecord,
} from "../../src/shared/renderer-diagnostics";

export function readDiagnosticRecords(file: string): DiagnosticRecord[] {
  if (!existsSync(file)) return [];
  if (statSync(file).size > 4 * 1024 * 1024)
    throw new Error("Diagnostic history exceeds its size limit");
  return diagnosticRecordsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function saveDiagnosticRecord(file: string, record: DiagnosticRecord): void {
  const reports = retainDiagnosticRecord(readDiagnosticRecords(file), record);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(reports), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}
