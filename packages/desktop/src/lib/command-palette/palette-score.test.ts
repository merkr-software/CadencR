import { describe, expect, it } from "vitest";
import { foldText, queryTokens, scoreFields } from "./palette-score";

function score(query: string, title: string, secondary: string[] = []) {
  return scoreFields(queryTokens(query), [
    { text: title, weight: 1 },
    ...secondary.map((text) => ({ text, weight: 0.6 })),
  ]);
}

describe("foldText", () => {
  it("drops case and accents while keeping one character per unit", () => {
    expect(foldText("Vérifier l’Outil")).toBe("verifier l'outil");
    expect(foldText("Ça")).toHaveLength(2);
  });
});

describe("scoreFields", () => {
  it("ranks the conversation whose title holds the word above loose matches", () => {
    const exact = score("palette", "Improve Command Palette Navigation", ["pianr-main"]);
    expect(exact).not.toBeNull();
    expect(
      score("palette", "Player — corriger les deux P2 terminaux révélés par Astra"),
    ).toBeNull();
  });

  it("refuses letters scattered across words", () => {
    expect(score("git", "Global Settings")).toBeNull();
    expect(score("zzz", "Investigate Production Build Size")).toBeNull();
  });

  it("matches without accents", () => {
    expect(score("verifier", "Vérifier l’Outil d’Archivage")?.ranges).toEqual([[0, 8]]);
  });

  it("matches the initials of consecutive words", () => {
    const match = score("cpn", "Improve Command Palette Navigation");
    expect(match?.ranges).toEqual([
      [8, 9],
      [16, 17],
      [24, 25],
    ]);
  });

  it("prefers a word start over the inside of a word", () => {
    const start = score("port", "Plan Linux Porting")!;
    const inside = score("port", "Fix Support Tickets")!;
    expect(start.score).toBeGreaterThan(inside.score);
  });

  it("needs every word, in any field", () => {
    expect(score("release cadencr", "Release v0.14.0", ["cadencr"])).not.toBeNull();
    expect(score("release pianr", "Release v0.14.0", ["cadencr"])).toBeNull();
  });

  it("rewards the words typed as one phrase in the title", () => {
    const phrase = score("command palette", "Improve Command Palette Navigation")!;
    const apart = score("command palette", "Command line, then a palette")!;
    expect(phrase.score).toBeGreaterThan(apart.score);
  });

  it("matches an abbreviation inside one word, never across words", () => {
    expect(score("cmd pal", "Improve Command Palette Navigation")).not.toBeNull();
    expect(score("gst", "Global Settings")).toBeNull();
  });

  it("tolerates a slip in a long word", () => {
    expect(score("navgation", "Improve Command Palette Navigation")).not.toBeNull();
  });
});
