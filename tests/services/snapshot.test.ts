import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentContext } from "@/services/context";
import { createFact, listFacts, retireFact } from "@/services/fact-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import {
  createAllergen,
  updateProfile,
} from "@/services/profile-service";
import { composeProfileSnapshot } from "@/services/snapshot-service";
import { setSlotConfig, listMealTypes } from "@/services/slot-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

/**
 * The snapshot is what the product actually sells, so this reads it the way an
 * agent would and checks that the dangerous things come first and that a gap in
 * the data is stated rather than implied.
 */

const ctx = testUser();
const agent = agentContext(ctx.userId, "client-xyz");

beforeAll(async () => {
  await ensureUserSetup(ctx);

  await updateProfile(ctx, {
    diet: "pescatarian",
    dietNotes: "Poisson deux fois par semaine maximum",
    skillLevel: 4,
    defaultServings: 3,
    defaultTimeBudgetMin: 35,
    varietyPreference: 4,
    timeBudgetToleranceMin: 15,
  });

  await createAllergen(ctx, {
    name: "Arachide",
    severity: "strict",
    matches: ["arachide", "cacahuète", "beurre de cacahuète"],
  });
  await createAllergen(ctx, {
    name: "Lactose",
    severity: "avoid",
    matches: ["lait", "crème"],
  });

  const dinnerId = (await listMealTypes(ctx)).find(
    (type) => type.key === "dinner",
  )!.id;
  await setSlotConfig(ctx, {
    dayOfWeek: 2,
    mealTypeId: dinnerId,
    state: "planned",
    timeBudgetMin: 20,
    defaultServings: 2,
  });
  await setSlotConfig(ctx, {
    dayOfWeek: 5,
    mealTypeId: dinnerId,
    state: "skipped",
    timeBudgetMin: null,
    defaultServings: null,
  });

  await createFact(ctx, {
    category: "health",
    statement: "Limite le sel, tension artérielle",
    polarity: "negative",
    confidence: "high",
  });
  await createFact(ctx, {
    category: "taste",
    statement: "Adore les plats mijotés",
    polarity: "positive",
    confidence: "high",
  });
  await createFact(agent, {
    category: "organization",
    statement: "Cuisine en grande quantité le dimanche",
    polarity: "neutral",
    confidence: "low",
  });
  await createFact(ctx, {
    category: "equipment",
    statement: "Utilise beaucoup la cocotte en fonte",
    polarity: "positive",
    confidence: "medium",
  });
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("the composed document", () => {
  it("states the hard constraint first, imperatively, with what triggers it", async () => {
    const { markdown } = await composeProfileSnapshot(ctx);

    const constraintsIndex = markdown.indexOf("## 1. Contraintes absolues");
    const tasteIndex = markdown.indexOf("## 6. Goûts");
    expect(constraintsIndex).toBeGreaterThan(-1);
    expect(constraintsIndex).toBeLessThan(tasteIndex);

    expect(markdown).toContain("**Ne proposez jamais**");
    expect(markdown).toContain("Arachide");
    expect(markdown).toContain("beurre de cacahuète");
    expect(markdown).toContain("pescétarien");
    expect(markdown).toContain("Poisson deux fois par semaine maximum");
  });

  it("separates an allergen to avoid from one that blocks", async () => {
    const { snapshot } = await composeProfileSnapshot(ctx);
    expect(snapshot.hardConstraints.strictAllergens.map((row) => row.name)).toEqual(
      ["Arachide"],
    );
    expect(
      snapshot.strongPreferences.avoidAllergens.map((row) => row.name),
    ).toEqual(["Lactose"]);
  });

  it("describes the week including the slot that must not be filled", async () => {
    const { markdown, snapshot } = await composeProfileSnapshot(ctx);
    expect(markdown).toContain("mardi dîner : planifié, 20 min");
    expect(markdown).toContain("vendredi dîner : sauté");
    expect(markdown).toContain("Tolérance de dépassement : 15 min");
    expect(snapshot.weekShape.defaultServings).toBe(3);
    expect(snapshot.weekShape.varietyPreference).toBe(4);
  });

  it("routes each fact to its section", async () => {
    const { snapshot } = await composeProfileSnapshot(ctx);

    expect(snapshot.strongPreferences.facts.map((row) => row.statement)).toContain(
      "Limite le sel, tension artérielle",
    );
    expect(snapshot.kitchen.facts.map((row) => row.statement)).toContain(
      "Utilise beaucoup la cocotte en fonte",
    );
    expect(snapshot.organizationFacts.map((row) => row.statement)).toContain(
      "Cuisine en grande quantité le dimanche",
    );
    expect(snapshot.tasteFacts.map((row) => row.statement)).toContain(
      "Adore les plats mijotés",
    );
  });

  it("marks an agent's unconfirmed claim as such, inline", async () => {
    const { markdown } = await composeProfileSnapshot(ctx);
    expect(markdown).toContain(
      "Cuisine en grande quantité le dimanche (confiance faible, non confirmé, écrit par un agent)",
    );
  });

  it("excludes a retired fact", async () => {
    const target = (await listFacts(ctx, { category: "taste" }))[0]!;
    await retireFact(ctx, target.id);

    const { markdown, snapshot } = await composeProfileSnapshot(ctx);
    expect(markdown).not.toContain(target.statement);
    expect(
      [
        ...snapshot.tasteFacts,
        ...snapshot.strongPreferences.facts,
        ...snapshot.kitchen.facts,
        ...snapshot.organizationFacts,
      ].some((row) => row.id === target.id),
    ).toBe(false);
  });

  it("has no unfilled section left to declare", async () => {
    const { snapshot } = await composeProfileSnapshot(ctx);
    // Every section the model defines is built as of phase 7. The field stays
    // so a future gap can be declared rather than rendered as silence.
    expect(snapshot.unavailable).toEqual([]);
  });

  it("carries all nine sections in the order the spec fixes", async () => {
    const { markdown } = await composeProfileSnapshot(ctx);
    const order = [
      "## 1. Contraintes absolues",
      "## 2. Préférences fortes",
      "## 3. La forme de la semaine",
      "## 4. La cuisine",
      "## 5. Organisation",
      "## 6. Goûts",
      "## 7. Placards",
      "## 8. Historique récent",
      "## 9. Signaux non résolus",
    ];
    const positions = order.map((heading) => markdown.indexOf(heading));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("says what an empty section means, rather than leaving it bare", async () => {
    const { markdown } = await composeProfileSnapshot(ctx);
    // Nothing recorded for this user, and the document is explicit that this
    // is absence of data rather than absence of the thing.
    expect(markdown).toContain(
      "Absence de retour ne veut pas dire que rien n'a été cuisiné.",
    );
    expect(markdown).toContain(
      "Cela ne veut pas dire que les placards sont vides",
    );
  });
});

describe("the fact budget", () => {
  it("states how much of the store the document shows", async () => {
    const { markdown, snapshot } = await composeProfileSnapshot(ctx, {
      factBudget: 1,
    });

    expect(snapshot.factBudget.included).toBe(1);
    expect(snapshot.factBudget.active).toBeGreaterThan(1);
    // Singular agreement: the document is read by a model but checked by a
    // person, and machine-sounding prose invites less scrutiny.
    expect(markdown).toContain(
      `Il contient 1 fait sur ${snapshot.factBudget.active} actifs`,
    );
    expect(markdown).toContain("Vous ne voyez donc pas tous les faits connus.");
  });

  it("keeps the health constraint when the budget is one fact", async () => {
    const { snapshot } = await composeProfileSnapshot(ctx, { factBudget: 1 });
    expect(snapshot.strongPreferences.facts.map((row) => row.statement)).toEqual([
      "Limite le sel, tension artérielle",
    ]);
  });
});

describe("recording that facts were handed out", () => {
  it("only bumps last_referenced_at when asked", async () => {
    const before = await listFacts(ctx, {});
    expect(before.every((row) => row.lastReferencedAt === null)).toBe(true);

    // Previewing your own snapshot must not distort the pruning heuristic.
    await composeProfileSnapshot(ctx, { markReferenced: false });
    const afterPreview = await listFacts(ctx, {});
    expect(afterPreview.every((row) => row.lastReferencedAt === null)).toBe(true);

    await composeProfileSnapshot(ctx, { markReferenced: true });
    const afterRead = await listFacts(ctx, {});
    expect(afterRead.some((row) => row.lastReferencedAt !== null)).toBe(true);
  });
});
