import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toCadencrError } from "@cadencr/tab-sdk";
import { useCadencr } from "@cadencr/tab-sdk/react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Skeleton,
} from "@cadencr/tab-kit";

interface About {
  folder: string;
  os: string;
  arch: string;
}

function isAbout(value: unknown): value is About {
  if (typeof value !== "object" || value === null) return false;
  const { folder, os, arch } = value as Record<string, unknown>;
  return typeof folder === "string" && typeof os === "string" && typeof arch === "string";
}

function isGreeting(value: unknown): value is { greeting: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).greeting === "string"
  );
}

export function App() {
  const client = useCadencr();
  const [about, setAbout] = useState<About | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState<string | null>(null);
  const [greetingPending, setGreetingPending] = useState(false);

  // The first request starts the backend; Cadencr stops it once the tab closes.
  const load = useCallback(async () => {
    setError(null);
    try {
      const reply = await client.backend.request("about");
      if (!isAbout(reply)) throw new Error("the backend answered something unexpected");
      setAbout(reply);
    } catch (failure) {
      // Every SDK failure is a CadencrError with a stable `code`, e.g.
      // PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM when no binary ships for here.
      setError(toCadencrError(failure).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const greet = async (event: FormEvent) => {
    event.preventDefault();
    setGreetingPending(true);
    setGreeting(null);
    try {
      const reply = await client.backend.request("greet", { name });
      if (!isGreeting(reply)) throw new Error("the backend answered without a greeting");
      setGreeting(reply.greeting);
    } catch (failure) {
      void client.ui.toast({ title: toCadencrError(failure).message, variant: "error" });
    } finally {
      setGreetingPending(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-6 text-foreground">
      <Card>
        <CardHeader>
          <CardTitle>Native backend</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {error ? (
            <EmptyState
              title="The backend didn't answer"
              description={`${error} Its log is in the tab's Activity (+ menu → Activity).`}
              action={
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  Try again
                </Button>
              }
            />
          ) : about ? (
            <>
              <Row label="Folder">{about.folder}</Row>
              <Row label="System">
                {about.os} · {about.arch}
              </Row>
            </>
          ) : (
            <>
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <form className="flex gap-2" onSubmit={(event) => void greet(event)}>
            <Input
              aria-label="Name"
              placeholder="Your name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={greetingPending || name.trim() === ""}>
              {greetingPending ? "Asking…" : "Greet"}
            </Button>
          </form>
          {greeting ? <p className="mt-3 text-sm">{greeting}</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}
