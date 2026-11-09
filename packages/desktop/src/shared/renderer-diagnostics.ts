import { z } from "zod";

const short = z.string().max(160);
const count = z.number().finite().nonnegative();
export const diagnosticEventSchema = z.object({
  at: count,
  kind: z.enum([
    "navigation",
    "interaction",
    "viewport",
    "visibility",
    "editor",
    "agents",
    "connection",
    "stream",
    "scroll",
    "lifecycle",
  ]),
  detail: z
    .record(z.string().max(40), z.union([short, z.number().finite(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 12),
  count: count,
});

export const diagnosticContextSchema = z.object({
  schemaVersion: z.literal(1),
  reportId: short,
  sessionId: short,
  capturedAt: short,
  appVersion: short,
  buildId: short,
  reactVersion: short,
  userAgent: z.string().max(400),
  route: z.string().max(256),
  viewport: z.object({ width: count, height: count, scale: count }),
  uptimeMs: count,
  duplicatesSuppressed: count,
  breadcrumbs: z.array(diagnosticEventSchema).max(100),
});

export type DiagnosticContext = z.infer<typeof diagnosticContextSchema>;
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;

const clipped = (max: number) => z.string().transform((value) => value.slice(0, max));
export const rendererErrorSchema = z.object({
  source: z.enum([
    "error",
    "unhandledrejection",
    "react-boundary",
    "react-uncaught",
    "react-recoverable",
  ]),
  message: clipped(4000),
  stack: clipped(12000).nullish(),
  componentStack: clipped(12000).nullish(),
  url: clipped(4000).nullish(),
  line: z.number().finite().nullish(),
  column: z.number().finite().nullish(),
  diagnostics: diagnosticContextSchema.optional(),
});

export const diagnosticRecordSchema = z.object({
  timestamp: short,
  appVersion: short,
  platform: short,
  arch: short,
  electron: short,
  chrome: short,
  error: rendererErrorSchema,
});
export const diagnosticRecordsSchema = z.array(diagnosticRecordSchema).max(10);
export type DiagnosticRecord = z.infer<typeof diagnosticRecordSchema>;

/** Dedupe repeats, never exhaust a lifetime budget and lose a later distinct crash. */
export function createDiagnosticGate(now: () => number = () => Date.now()) {
  const recent = new Map<string, { at: number; context?: DiagnosticContext }>();
  let suppressed = 0;
  const fingerprint = (error: z.infer<typeof rendererErrorSchema>) =>
    JSON.stringify([
      error.source,
      error.message.slice(0, 4000),
      error.stack?.slice(0, 12000),
      error.componentStack?.slice(0, 12000),
    ]);
  return {
    accept(error: z.infer<typeof rendererErrorSchema>): boolean {
      const key = fingerprint(error);
      const time = now();
      const previous = recent.get(key);
      if (previous !== undefined && time - previous.at < 10_000) {
        suppressed += 1;
        return false;
      }
      recent.delete(key);
      recent.set(key, { at: time, context: error.diagnostics });
      if (recent.size > 64) recent.delete(recent.keys().next().value!);
      return true;
    },
    suppressed: () => suppressed,
    previousContext: (error: z.infer<typeof rendererErrorSchema>) =>
      recent.get(fingerprint(error))?.context,
  };
}

const resizeObserverNoiseMessages = new Set([
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop limit exceeded.",
]);

/** A browser layout notification, not a thrown error: it never carries a stack or location. */
export function isResizeObserverNoise(
  error: Pick<z.infer<typeof rendererErrorSchema>, "source" | "message">,
): boolean {
  return error.source === "error" && resizeObserverNoiseMessages.has(error.message);
}

export function retainDiagnosticRecord(
  records: DiagnosticRecord[],
  record: DiagnosticRecord,
): DiagnosticRecord[] {
  const next = [...records, record];
  if (next.length > 10) {
    // Evict known ResizeObserver noise, then React recovery, then the oldest
    // remaining report. Include the incoming record so noise cannot displace evidence.
    const noise = next.findIndex(({ error }) => isResizeObserverNoise(error));
    const recoverable = next.findIndex((item) => item.error.source === "react-recoverable");
    next.splice(noise >= 0 ? noise : recoverable >= 0 ? recoverable : 0, 1);
  }
  return next;
}
