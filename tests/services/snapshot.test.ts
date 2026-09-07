import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentContext, type ServiceContext } from "@/services/context";
import { createFact, listFacts, retireFact } from "@/services/fact-service";
import { createAllergen, updateProfile } from "@/services/profile-service";
import { composeProfileSnapshot } from "@/services/snapshot-service";
import { setSlotConfig } from "@/services/slot-service";
import { setupTestUser } from "../helpers";

/**
 * The snapshot is what the product actually sells, so this reads it the way an
 * agent would and checks that the dangerous things come first and that a gap in
 * the data is stated rather than implied.
 */

let user: Awaited<ReturnType<typeof setupTestUser>>;
let ctx: ServiceContext;
let agent: ServiceContext;

beforeAll(async () => {
  user = await setupTestUser();
  ctx = user.ctx;
  agent = agentContext(ctx.userId, "client-xyz");

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

  const dinnerId = user.dinnerId;
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
  await user.cleanup();
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
    expect(
      snapshot.hardConstraints.strictAllergens.map((row) => row.name),
    ).toEqual(["Arachide"]);
    expect(
      snapshot.strongPreferences.avoidAllergens.map((row) => row.name),
    ).toEqual(["Lactose"]);
  });

  it("describes the week including the slot that must not be filled", async () => {
    /*
     * Read off the snapshot object rather than out of the French sentence the
     * service composes. This used to assert "mardi dîner : planifié, 20 min"
     * and "vendredi dîner : sauté" as literal substrings, so every copy edit
     * broke a test about slot state, and the thing being tested, that a skipped
     * slot is carried through and labelled, is a field.
     */
    const { snapshot } = await composeProfileSnapshot(ctx);

    const tuesday = snapshot.weekShape.slots.find(
      (slot) => slot.dayOfWeek === 2 && slot.mealTypeLabel === "Dîner",
    );
    const friday = snapshot.weekShape.slots.find(
      (slot) => slot.dayOfWeek === 5 && slot.mealTypeLabel === "Dîner",
    );

    expect(tuesday).toMatchObject({ state: "planned", timeBudgetMin: 20 });
    // The one that matters: an agent that fills a skipped slot has broken a
    // promise, so the state has to survive into the document.
    expect(friday?.state).toBe("skipped");

    expect(snapshot.weekShape.defaultServings).toBe(3);
    expect(snapshot.weekShape.varietyPreference).toBe(4);
    expect(snapshot.weekShape.timeBudgetToleranceMin).toBe(15);
  });

  it("routes each fact to its section", async () => {
    const { snapshot } = await composeProfileSnapshot(ctx);

    expect(
      snapshot.strongPreferences.facts.map((row) => row.statement),
    ).toContain("Limite le sel, tension artérielle");
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
    const { markdown, snapshot } = await composeProfileSnapshot(ctx);

    // The fields first, since they are what the annotation is rendered from.
    const claim = snapshot.organizationFacts.find(
      (row) => row.statement === "Cuisine en grande quantité le dimanche",
    );
    expect(claim).toMatchObject({
      status: "unconfirmed",
      source: "agent",
      confidence: "low",
    });

    /*
     * And one assertion on the document, because inline is the point: an agent
     * reading a flat list of statements cannot tell which of them a human
     * actually confirmed, and a footnote is not read. The whole parenthetical
     * used to be asserted word for word; this pins that the annotation is on
     * the same line as the claim and says it is unconfirmed, and leaves the
     * wording to the catalogue.
     */
    const line = markdown
      .split("\n")
      .find((row) => row.includes("Cuisine en grande quantité le dimanche"));
    expect(line).toBeDefined();
    expect(line).toContain("non confirmé");
    expect(line).toContain("agent");
  });

  it("excludes a retired fact", async () => {
    // Its own fact, created and retired here. It used to take whichever taste
    // fact happened to come back first and retire it, which both depended on
    // the ordering of a query and mutated a row two later `describe` blocks
    // read, so a reordering or a `-t` filter changed what those blocks saw.
    const target = await createFact(ctx, {
      category: "taste",
      statement: "Fait de goût créé pour être retiré",
      polarity: "neutral",
      confidence: "low",
    });
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

    /*
     * Structural rather than two French sentences quoted verbatim.
     *
     * The rule is that a section with no data still says something, because an
     * empty heading reads to a model as "this person has no preferences"
     * rather than as "nothing was recorded", and the two lead to different
     * weeks. Every section is checked, not the two that happen to be empty for
     * this account: a heading with nothing under it is the defect whichever
     * heading it is.
     */
    const sections = markdown
      .split(/^## /m)
      .slice(1)
      .map((section) => {
        const [heading = "", ...body] = section.split("\n");
        return { heading, body: body.join("\n").trim() };
      });

    expect(sections).toHaveLength(9);
    for (const section of sections) {
      expect(
        section.body,
        `section "${section.heading}" is a heading with nothing under it`,
      ).not.toBe("");
    }

    /*
     * And the two sections where absence is genuinely ambiguous get a sentence
     * rather than a word. "Rien à signaler." is enough for the signals
     * section, because no signal means no signal. An empty history could mean
     * nothing was cooked or that nobody filled in the feedback, and an empty
     * pantry could mean the cupboards are bare or that the list was never
     * started: read the wrong way round, either one produces a week built on a
     * false premise, so the document has to say which it is.
     */
    const history = sections.find((section) =>
      section.heading.startsWith("8."),
    );
    const pantry = sections.find((section) => section.heading.startsWith("7."));
    expect(history?.body.length ?? 0).toBeGreaterThan(60);
    expect(pantry?.body.length ?? 0).toBeGreaterThan(60);
    expect(history?.body).toMatch(/ne veut pas dire/);
    expect(pantry?.body).toMatch(/ne veut pas dire/);
  });
});

describe("the fact budget", () => {
  it("states how much of the store the document shows", async () => {
    const { markdown, snapshot } = await composeProfileSnapshot(ctx, {
      factBudget: 1,
    });

    expect(snapshot.factBudget.included).toBe(1);
    expect(snapshot.factBudget.active).toBeGreaterThan(1);

    /*
     * The numbers, and the singular agreement, without quoting the sentence
     * around them. "1 fait" and not "1 faits": the document is read by a model
     * but checked by a person, and machine-sounding prose invites less
     * scrutiny. That is the assertion; the clause it sits in is copy.
     */
    expect(markdown).toMatch(
      new RegExp(`\\b1 fait sur ${snapshot.factBudget.active} actifs?\\b`),
    );
    // And the document says out loud that it is partial, which is the whole
    // reason the budget is reported at all.
    expect(markdown).toMatch(/pas tous les faits/);
  });

  it("keeps the health constraint when the budget is one fact", async () => {
    const { snapshot } = await composeProfileSnapshot(ctx, { factBudget: 1 });
    expect(
      snapshot.strongPreferences.facts.map((row) => row.statement),
    ).toEqual(["Limite le sel, tension artérielle"]);
  });
});

describe("recording that facts were handed out", () => {
  it("only bumps last_referenced_at when asked", async () => {
    const before = await listFacts(ctx, {});
    expect(before.every((row) => row.lastReferencedAt === null)).toBe(true);

    // Previewing your own snapshot must not distort the pruning heuristic.
    await composeProfileSnapshot(ctx, { markReferenced: false });
    const afterPreview = await listFacts(ctx, {});
    expect(afterPreview.every((row) => row.lastReferencedAt === null)).toBe(
      true,
    );

    await composeProfileSnapshot(ctx, { markReferenced: true });
    const afterRead = await listFacts(ctx, {});
    expect(afterRead.some((row) => row.lastReferencedAt !== null)).toBe(true);
  });
});
