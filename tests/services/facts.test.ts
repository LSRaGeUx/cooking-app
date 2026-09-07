import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentContext } from "@/services/context";
import {
  confirmFact,
  countActiveFacts,
  createFact,
  listFacts,
  retireFact,
  retirementCandidates,
  supersedeFact,
  updateFactMetadata,
} from "@/services/fact-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import { cleanupUser, expectDomainError, testUser } from "../helpers";

/**
 * The fact store is the moat, so these tests are about what an agent cannot do
 * to it, and about the fact that no meaning is ever overwritten.
 */

const ctx = testUser();
const agent = agentContext(ctx.userId, "client-abc");

beforeAll(async () => {
  await ensureUserSetup(ctx);
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("who wrote a fact decides its status", () => {
  it("takes a user's fact as confirmed", async () => {
    const created = await createFact(ctx, {
      category: "taste",
      statement: "N'aime pas la coriandre",
      polarity: "negative",
      confidence: "high",
    });

    expect(created).toMatchObject({
      status: "confirmed",
      source: "user",
      sourceClientId: null,
    });
  });

  it("takes an agent's fact as unconfirmed and stamps the client", async () => {
    const created = await createFact(agent, {
      category: "organization",
      statement: "Rentre tard le mardi",
      polarity: "neutral",
      confidence: "low",
    });

    expect(created).toMatchObject({
      status: "unconfirmed",
      source: "agent",
      sourceClientId: "client-abc",
    });
  });

  it("gives an agent no way to confirm its own claim", async () => {
    const created = await createFact(agent, {
      category: "taste",
      statement: "Adore le curry",
      polarity: "positive",
      confidence: "medium",
    });

    await expect(confirmFact(agent, created.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // A human can.
    const confirmed = await confirmFact(ctx, created.id);
    expect(confirmed.status).toBe("confirmed");
  });
});

describe("a fact is never rewritten to mean something else", () => {
  it("moves category and confidence in place", async () => {
    const created = await createFact(ctx, {
      category: "other",
      statement: "Cuisine surtout le dimanche",
      polarity: "neutral",
      confidence: "low",
    });

    const updated = await updateFactMetadata(ctx, created.id, {
      category: "organization",
      confidence: "high",
    });

    expect(updated).toMatchObject({
      id: created.id,
      category: "organization",
      confidence: "high",
      statement: "Cuisine surtout le dimanche",
    });
  });

  it("refuses a metadata update that changes nothing", async () => {
    const created = await createFact(ctx, {
      category: "taste",
      statement: "Aime les plats épicés",
      polarity: "positive",
      confidence: "medium",
    });
    await expectDomainError(
      updateFactMetadata(ctx, created.id, {}),
      "VALIDATION",
    );
  });

  it("resolves a contradiction by retiring and replacing, keeping both", async () => {
    const original = await createFact(ctx, {
      category: "taste",
      statement: "Déteste les champignons",
      polarity: "negative",
      confidence: "high",
    });

    const { retired, created } = await supersedeFact(ctx, original.id, {
      category: "taste",
      statement: "Mange des champignons depuis 2026",
      polarity: "positive",
      confidence: "medium",
    });

    expect(retired).toMatchObject({ id: original.id, status: "retired" });
    expect(retired.retiredAt).not.toBeNull();
    expect(created.supersedesId).toBe(original.id);

    // The old statement is still there for anyone who asks for it, which is the
    // whole point: a taste that changed is signal.
    const withRetired = await listFacts(ctx, { includeRetired: true });
    expect(
      withRetired.some((row) => row.statement === "Déteste les champignons"),
    ).toBe(true);

    const active = await listFacts(ctx, {});
    expect(
      active.some((row) => row.statement === "Déteste les champignons"),
    ).toBe(false);
  });
});

describe("retiring and filtering", () => {
  it("excludes retired facts by default and refuses to retire twice", async () => {
    const created = await createFact(ctx, {
      category: "social",
      statement: "Reçoit des amis le samedi",
      polarity: "neutral",
      confidence: "medium",
    });

    await retireFact(ctx, created.id);
    const active = await listFacts(ctx, {});
    expect(active.some((row) => row.id === created.id)).toBe(false);

    await expectDomainError(retireFact(ctx, created.id), "NOT_FOUND");
  });

  it("filters by category and by status", async () => {
    const tasteOnly = await listFacts(ctx, { category: "taste" });
    expect(tasteOnly.every((row) => row.category === "taste")).toBe(true);

    const unconfirmed = await listFacts(ctx, { status: "unconfirmed" });
    expect(unconfirmed.every((row) => row.status === "unconfirmed")).toBe(true);
  });

  it("shows unconfirmed facts first, because that is what needs review", async () => {
    const all = await listFacts(ctx, {});
    const firstConfirmed = all.findIndex((row) => row.status === "confirmed");
    const lastUnconfirmed = all
      .map((row) => row.status)
      .lastIndexOf("unconfirmed");
    if (firstConfirmed !== -1 && lastUnconfirmed !== -1) {
      expect(lastUnconfirmed).toBeLessThan(firstConfirmed);
    }
  });
});

describe("the cap", () => {
  it("rejects a write past the cap and names what to retire", async () => {
    const active = await countActiveFacts(ctx);

    const error = await expectDomainError(
      createFact(
        ctx,
        {
          category: "other",
          statement: "Un fait de trop",
          polarity: "neutral",
          confidence: "low",
        },
        { cap: active },
      ),
      "FACT_CAP_REACHED",
    );
    expect(error.details).toMatchObject({ active, cap: active });
    expect(Array.isArray(error.details.candidates)).toBe(true);
  });

  it("still allows a replacement at the cap, because it does not add one", async () => {
    /*
     * A fixture with a category this test chose, rather than
     * `target.category as "taste"` on whatever row happened to come back first.
     * That cast asserted a category the fixture never set and would have gone
     * on compiling after the enum changed underneath it.
     */
    const target = await createFact(ctx, {
      category: "taste",
      statement: "Fait à remplacer exactement au plafond",
      polarity: "neutral",
      confidence: "medium",
    });
    const active = await countActiveFacts(ctx);

    const { created } = await supersedeFact(
      ctx,
      target.id,
      {
        category: "taste",
        statement: "Version remplacée au plafond",
        polarity: "neutral",
        confidence: "medium",
      },
      { cap: active },
    );

    expect(created.supersedesId).toBe(target.id);
    expect(await countActiveFacts(ctx)).toBe(active);
  });

  it("offers the least recently referenced unconfirmed facts as candidates", async () => {
    const candidates = await retirementCandidates(ctx, 3);
    expect(candidates.every((row) => row.status === "unconfirmed")).toBe(true);
  });
});
