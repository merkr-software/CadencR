/**
 * From `git log` lines to a ranking of the people who know the changed code.
 * Pure: no SDK, no React — the hook feeds it command output.
 */

/** `git log --format=` producing one `email<TAB>name<TAB>unix-seconds` line per commit. */
export const LOG_FORMAT = "%aE%x09%aN%x09%at";

/** Commits read per file: enough to rank, cheap to run. */
export const COMMITS_PER_FILE = 60;

export interface Commit {
  email: string;
  name: string;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface Person {
  email: string;
  name: string;
  /** Commits on the changed files, all files together. */
  commits: number;
  /** Changed files this person committed to, most commits first. */
  files: { path: string; commits: number }[];
  /** Their most recent commit on any of the changed files. */
  lastAt: number;
  /** The Git identity of whoever runs Cadencr. */
  isYou: boolean;
}

export function parseLog(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of stdout.split("\n")) {
    const [email, name, seconds] = line.split("\t");
    if (!email || !name || !seconds) continue;
    const at = Number(seconds) * 1000;
    if (Number.isFinite(at)) commits.push({ email: email.toLowerCase(), name, at });
  }
  return commits;
}

/**
 * Rank everyone who committed to `history` (path → commits). A person
 * spread over many changed files outranks one with many commits on a single
 * file: they know more of what is changing.
 */
export function rankPeople(history: ReadonlyMap<string, Commit[]>, you: string | null): Person[] {
  const people = new Map<string, Person>();
  for (const [path, commits] of history) {
    const perPerson = new Map<string, number>();
    for (const commit of commits) {
      const person = people.get(commit.email) ?? {
        email: commit.email,
        name: commit.name,
        commits: 0,
        files: [],
        lastAt: 0,
        isYou: commit.email === you,
      };
      person.commits += 1;
      person.lastAt = Math.max(person.lastAt, commit.at);
      people.set(commit.email, person);
      perPerson.set(commit.email, (perPerson.get(commit.email) ?? 0) + 1);
    }
    for (const [email, count] of perPerson) people.get(email)?.files.push({ path, commits: count });
  }
  const ranked = [...people.values()];
  for (const person of ranked) person.files.sort((a, b) => b.commits - a.commits);
  return ranked.sort(
    (a, b) => b.files.length - a.files.length || b.commits - a.commits || b.lastAt - a.lastAt,
  );
}
