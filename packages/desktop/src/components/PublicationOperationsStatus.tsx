import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  listPublicationOperations,
  getPublicationOperation,
  getListPublicationOperationsQueryKey,
  getGetPublicationOperationQueryKey,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { marketplaceError } from "@/lib/marketplace";

const githubUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
const operation = z.object({
  operation_id: z.string().regex(/^[a-f0-9]{64}$/),
  project_id: z.number(),
  kind: z.enum(["release", "registry"]),
  status: z.enum(["pending", "running", "succeeded", "failed", "unknown"]),
  attempt: z.number(),
  updated_at: z.string(),
  error: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
  result: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("release"), value: z.object({ release_url: githubUrl }) }),
      z.object({ kind: z.literal("registry"), value: z.object({ pull_request_url: githubUrl }) }),
    ])
    .nullable()
    .optional(),
});
const page = z.object({
  operations: z.array(operation),
  next_cursor: z.string().nullable().optional(),
});
type Operation = z.infer<typeof operation>;

/** Server-confirmed journal only; never derives publication outcome from a lost POST. */
export function PublicationOperationsStatus({
  projectId,
  operationId,
  publicationPending = false,
}: {
  projectId: number;
  operationId?: string;
  publicationPending?: boolean;
}): React.JSX.Element {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const query = useQuery({
    queryKey: getListPublicationOperationsQueryKey(projectId, { limit: 20, cursor }),
    queryFn: async ({ signal }) =>
      page.parse(await listPublicationOperations(projectId, { limit: 20, cursor }, signal)),
    refetchInterval: (state) =>
      publicationPending || state.state.data?.operations.some(isActive) ? 3000 : false,
  });
  const focused = useQuery({
    queryKey: getGetPublicationOperationQueryKey(projectId, operationId ?? ""),
    enabled: !!operationId,
    queryFn: async ({ signal }) =>
      operation.parse(await getPublicationOperation(projectId, operationId ?? "", signal)),
    retry: false,
    refetchInterval: (state) =>
      publicationPending || (state.state.data && isActive(state.state.data)) ? 3000 : false,
  });
  return (
    <section
      aria-label="Persisted publication operations"
      className="space-y-2 rounded-lg border p-3 text-xs"
    >
      <p className="font-medium">Persisted publication operations</p>
      <OperationExplanation />
      {query.isPending ? <p role="status">Loading publication operation journal…</p> : null}
      {query.isError ? (
        <p role="alert" className="text-destructive">
          {marketplaceError(query.error)}
        </p>
      ) : null}
      {operationId ? (
        <FocusedOperationState
          loading={focused.isPending}
          error={focused.isError ? focused.error : null}
        />
      ) : null}
      {focused.data ? <OperationStatus operation={focused.data} /> : null}
      {query.data?.operations
        .filter((value) => value.operation_id !== focused.data?.operation_id)
        .map((value) => (
          <OperationStatus key={value.operation_id} operation={value} />
        ))}
      {query.data?.operations.length === 0 ? <p>No recorded publication operations.</p> : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => {
            void query.refetch();
            if (operationId) void focused.refetch();
          }}
        >
          {query.isFetching ? "Refreshing…" : "Refresh operation status"}
        </Button>
        {cursors.length ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCursors((values) => values.slice(0, -1))}
          >
            Previous operations
          </Button>
        ) : null}
        {query.data?.next_cursor ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const next = query.data?.next_cursor;
              if (next) setCursors((values) => [...values, next]);
            }}
          >
            More operations
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function FocusedOperationState({
  loading,
  error,
}: {
  loading: boolean;
  error: unknown;
}): React.JSX.Element | null {
  if (loading) return <p role="status">Loading this publication operation…</p>;
  if (!error) return null;
  const missing = z
    .object({ response: z.object({ status: z.literal(404) }) })
    .safeParse(error).success;
  return missing ? (
    <p role="status">
      No recorded operation is available for this ID yet. Refresh to verify whether the request was
      accepted; a missing record does not prove that publication failed or never started.
    </p>
  ) : (
    <p role="alert" className="text-destructive">
      Operation status could not be retrieved: {marketplaceError(error)}
    </p>
  );
}

function OperationExplanation(): React.JSX.Element {
  return (
    <p className="text-muted-foreground">
      Work continues if this view disconnects. Unknown means the remote outcome must be reconciled,
      not that publication failed.
    </p>
  );
}

function OperationStatus({ operation: value }: { operation: Operation }): React.JSX.Element {
  const resultUrl =
    value.result?.kind === "release"
      ? value.result.value.release_url
      : value.result?.value.pull_request_url;
  return (
    <div role="status" className="space-y-1 border-t pt-2">
      <p>
        {value.kind} · {value.status} · attempt {value.attempt}
      </p>
      <p className="break-all font-mono">{value.operation_id}</p>
      {value.error ? (
        <p className="text-muted-foreground">
          {value.error_code}: {value.error}
        </p>
      ) : null}
      {resultUrl ? <p className="break-all">Result: {resultUrl}</p> : null}
    </div>
  );
}

function isActive(value: Operation): boolean {
  return value.status === "pending" || value.status === "running";
}
