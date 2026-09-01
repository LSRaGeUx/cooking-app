import { describe, expect, it } from "vitest";
import {
  orderTasteFacts,
  sectionOfFact,
  selectFactsForBudget,
  type RankedFact,
  type SnapshotFact,
} from "@/domain/snapshot";

function ranked(overrides: Partial<RankedFact>): RankedFact {
  return {
    id: Math.random().toString(36).slice(2),
    statement: "Un fait",
    category: "taste",
    polarity: "neutral",
    confidence: "medium",
    status: "confirmed",
    source: "user",
    lastReferencedAt: null,
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("selecting facts under a budget", () => {
  it("keeps confirmed before unconfirmed, then confidence, then recency", () => {
    const selected = selectFactsForBudget(
      [
        ranked({ statement: "unconfirmed high", status: "unconfirmed", confidence: "high" }),
        ranked({ statement: "confirmed low", confidence: "low" }),
        ranked({ statement: "confirmed high", confidence: "high" }),
      ],
      2,
    );

    expect(selected.map((row) => row.statement)).toEqual([
      "confirmed high",
      "confirmed low",
    ]);
  });

  it("never drops a health fact, whatever the budget", () => {
    // The budget cutting into a health constraint is the one failure mode that
    // is dangerous rather than merely unhelpful.
    const selected = selectFactsForBudget(
      [
        ranked({ statement: "goût A", confidence: "high" }),
        ranked({ statement: "goût B", confidence: "high" }),
        ranked({
          statement: "sel limité, tension",
          category: "health",
          status: "unconfirmed",
          confidence: "low",
        }),
      ],
      1,
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.statement).toBe("sel limité, tension");
  });

  it("pins a confirmed high-confidence rejection to the front", () => {
    const selected = selectFactsForBudget(
      [
        ranked({ statement: "aime le poisson", polarity: "positive", confidence: "high" }),
        ranked({
          statement: "ne mange jamais de porc",
          polarity: "negative",
          confidence: "high",
        }),
      ],
      1,
    );

    expect(selected[0]?.statement).toBe("ne mange jamais de porc");
  });

  it("prefers a recently referenced fact over a forgotten one", () => {
    const selected = selectFactsForBudget(
      [
        ranked({ statement: "oublié", lastReferencedAt: null }),
        ranked({ statement: "récent", lastReferencedAt: new Date("2026-08-01") }),
      ],
      1,
    );
    expect(selected[0]?.statement).toBe("récent");
  });
});

describe("routing a fact into a section", () => {
  function fact(overrides: Partial<SnapshotFact>): SnapshotFact {
    return {
      id: "f",
      statement: "s",
      category: "taste",
      polarity: "neutral",
      confidence: "medium",
      status: "confirmed",
      source: "user",
      ...overrides,
    };
  }

  it("gives every category a home, so no fact is written and never read", () => {
    expect(sectionOfFact(fact({ category: "health" }))).toBe("strong");
    expect(sectionOfFact(fact({ category: "equipment" }))).toBe("kitchen");
    expect(sectionOfFact(fact({ category: "technique" }))).toBe("kitchen");
    expect(sectionOfFact(fact({ category: "organization" }))).toBe("organization");
    expect(sectionOfFact(fact({ category: "pantry_habit" }))).toBe("organization");
    expect(sectionOfFact(fact({ category: "social" }))).toBe("organization");
    expect(sectionOfFact(fact({ category: "taste" }))).toBe("taste");
    expect(sectionOfFact(fact({ category: "other" }))).toBe("taste");
  });

  it("lifts a confirmed high-confidence rejection out of taste", () => {
    expect(
      sectionOfFact(
        fact({ category: "taste", polarity: "negative", confidence: "high" }),
      ),
    ).toBe("strong");
  });
});

describe("ordering taste facts", () => {
  it("puts positive before negative and confirmed before unconfirmed", () => {
    const ordered = orderTasteFacts([
      {
        id: "1",
        statement: "négatif",
        category: "taste",
        polarity: "negative",
        confidence: "low",
        status: "confirmed",
        source: "user",
      },
      {
        id: "2",
        statement: "positif non confirmé",
        category: "taste",
        polarity: "positive",
        confidence: "low",
        status: "unconfirmed",
        source: "agent",
      },
      {
        id: "3",
        statement: "positif confirmé",
        category: "taste",
        polarity: "positive",
        confidence: "low",
        status: "confirmed",
        source: "user",
      },
    ]);

    expect(ordered.map((row) => row.statement)).toEqual([
      "positif confirmé",
      "positif non confirmé",
      "négatif",
    ]);
  });
});
