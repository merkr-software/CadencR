import { describe, expect, it } from "vitest";
import type { Project } from "@/api/generated";
import {
  findFilterTokenAtOffset,
  getUnifiedAgentsFilterSuggestions,
  parseUnifiedAgentsFilterText,
  replaceFilterToken,
  serializeUnifiedAgentsFilterText,
} from "@/components/UnifiedAgentsFilterLanguage";

const PROJECTS: Project[] = [
  { created_at: "2026-01-01 00:00:00", id: 1, name: "Core App", path: "/repo/core" },
  { created_at: "2026-01-01 00:00:00", id: 2, name: "Marketing", path: "/repo/marketing" },
  { created_at: "2026-01-01 00:00:00", id: 3, name: "Agent Lab", path: "/repo/agent-lab" },
];

describe("UnifiedAgentsFilterLanguage", () => {
  it("parses slash filters with free text agent-name search", () => {
    expect(
      parseUnifiedAgentsFilterText(
        '/last:20 /project:"Core App" /sort:-message auth bug',
        PROJECTS,
      ),
    ).toEqual({
      mode: "recent",
      freshMinutes: 20,
      projectIds: [1],
      excludedTitles: [],
      pinnedOnly: false,
      query: "auth bug",
      sortOrder: "activity_asc",
    });
  });

  it("treats non-slash key:value text as free text", () => {
    expect(parseUnifiedAgentsFilterText('last:20 project:"Core App" auth', PROJECTS)).toMatchObject(
      {
        mode: "recent",
        freshMinutes: 5,
        projectIds: [],
        query: 'last:20 project:"Core App" auth',
        sortOrder: "created_desc",
      },
    );
  });

  it("supports multiple slash project values", () => {
    expect(
      parseUnifiedAgentsFilterText(
        '/last:all /project:"Core App"|Marketing /sort:created',
        PROJECTS,
      ),
    ).toEqual({
      mode: "all",
      freshMinutes: 5,
      projectIds: [1, 2],
      excludedTitles: [],
      pinnedOnly: false,
      query: "",
      sortOrder: "created_desc",
    });
  });

  it("serializes filters with slash-prefixed project names", () => {
    expect(
      serializeUnifiedAgentsFilterText(
        {
          mode: "recent",
          freshMinutes: 60,
          projectIds: [1, 3],
          excludedTitles: [],
          pinnedOnly: false,
          query: "review ui",
          sortOrder: "created_asc",
        },
        PROJECTS,
      ),
    ).toBe('/last:60 /sort:-created /project:"Core App"|"Agent Lab" review ui');
  });

  it("does not reinsert default filters into the prompt", () => {
    expect(
      serializeUnifiedAgentsFilterText(
        {
          mode: "recent",
          freshMinutes: 5,
          projectIds: [],
          excludedTitles: [],
          pinnedOnly: false,
          query: "review ui",
          sortOrder: "created_desc",
        },
        PROJECTS,
      ),
    ).toBe("review ui");
  });

  it("keeps non-default filters visible in the prompt", () => {
    expect(
      serializeUnifiedAgentsFilterText(
        {
          mode: "all",
          freshMinutes: 5,
          projectIds: [],
          excludedTitles: [],
          pinnedOnly: false,
          query: "",
          sortOrder: "activity_desc",
        },
        PROJECTS,
      ),
    ).toBe("/last:all /sort:message");
  });

  it("parses /exclude into a deduped, quote-aware title list", () => {
    expect(
      parseUnifiedAgentsFilterText('/exclude:auth|"Docs site"|AUTH bug', PROJECTS),
    ).toMatchObject({
      excludedTitles: ["auth", "Docs site"],
      query: "bug",
    });
  });

  it("serializes excluded titles with quoting", () => {
    expect(
      serializeUnifiedAgentsFilterText(
        {
          mode: "recent",
          freshMinutes: 5,
          projectIds: [],
          excludedTitles: ["auth", "Docs site"],
          pinnedOnly: false,
          query: "",
          sortOrder: "created_desc",
        },
        PROJECTS,
      ),
    ).toBe('/exclude:auth|"Docs site"');
  });

  it("round-trips /exclude through parse and serialize", () => {
    const text = '/exclude:auth|"Docs site"';
    expect(
      serializeUnifiedAgentsFilterText(parseUnifiedAgentsFilterText(text, PROJECTS), PROJECTS),
    ).toBe(text);
  });

  it("parses /pin into a pinnedOnly flag", () => {
    expect(parseUnifiedAgentsFilterText("/pin:true review", PROJECTS)).toMatchObject({
      pinnedOnly: true,
      query: "review",
    });
    expect(parseUnifiedAgentsFilterText("/pin:false review", PROJECTS)).toMatchObject({
      pinnedOnly: false,
    });
  });

  it("serializes pinnedOnly back to /pin:true and round-trips", () => {
    const text = serializeUnifiedAgentsFilterText(
      {
        mode: "recent",
        freshMinutes: 5,
        projectIds: [],
        excludedTitles: [],
        pinnedOnly: true,
        query: "",
        sortOrder: "created_desc",
      },
      PROJECTS,
    );
    expect(text).toBe("/pin:true");
    expect(parseUnifiedAgentsFilterText(text, PROJECTS)).toMatchObject({ pinnedOnly: true });
  });

  it("suggests the pin key and value after a slash trigger", () => {
    expect(getUnifiedAgentsFilterSuggestions("/pi", PROJECTS)[0]).toMatchObject({
      replacement: "/pin:",
      key: "pin",
    });
    expect(getUnifiedAgentsFilterSuggestions("/pin:", PROJECTS)[0]).toMatchObject({
      replacement: "/pin:true",
      key: "pin",
    });
  });

  it("suggests the exclude key after a slash trigger", () => {
    expect(getUnifiedAgentsFilterSuggestions("/exc", PROJECTS)[0]).toMatchObject({
      replacement: "/exclude:",
      key: "exclude",
    });
  });

  it("keeps invalid slash filters as free text", () => {
    expect(parseUnifiedAgentsFilterText("/unknown:value auth /sort:wat", PROJECTS)).toMatchObject({
      query: "/unknown:value auth",
      sortOrder: "created_desc",
    });
  });

  it("suggests the current project value after a pipe separator", () => {
    expect(getUnifiedAgentsFilterSuggestions('/project:"Core App"|ag', PROJECTS)[0]).toMatchObject({
      label: "Agent Lab",
      replacement: '/project:"Core App"|"Agent Lab"',
    });
  });

  it("suggests only after slash trigger", () => {
    expect(getUnifiedAgentsFilterSuggestions("project:ag", PROJECTS)).toEqual([]);
    expect(getUnifiedAgentsFilterSuggestions("/project:ag", PROJECTS)[0]).toMatchObject({
      label: "Agent Lab",
      replacement: '/project:"Agent Lab"',
    });
  });

  it("replaces only the active slash token when applying value suggestions", () => {
    const text = "auth /sort:m";
    const token = findFilterTokenAtOffset(text, text.length);

    if (!token) throw new Error("Expected active token");
    expect(replaceFilterToken(text, token, "/sort:message").text).toBe("auth /sort:message ");
  });

  it("does not add a trailing space after key suggestions", () => {
    const text = "auth /so";
    const token = findFilterTokenAtOffset(text, text.length);

    if (!token) throw new Error("Expected active token");
    expect(replaceFilterToken(text, token, "/sort:").text).toBe("auth /sort:");
  });
});
